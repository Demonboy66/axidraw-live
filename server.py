#!/usr/bin/env python3
"""AxiDraw Live - a local bridge between the drawing app (in your browser) and an AxiDraw.

Serves the app from ./web and accepts strokes over a small JSON API, which a single worker thread plots with the AxiDraw
Python API's interactive mode - in millimetres, one stroke at a time, each at its own pen-down height (so pressure can set
how hard a spring-loaded pen presses) and its layer's speed. Strokes queue up, so you can draw faster than the plotter.

Run with the bundled environment:
    .venv/bin/python server.py              # then open http://127.0.0.1:8765
    .venv/bin/python server.py --port 9000

"Simulate" mode (chosen in the app) does everything except move the plotter, so the app can be tried without one.
"""

import argparse
import json
import math
import mimetypes
import os
import queue
import threading
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Plotter settings the app can change, with their AxiDraw API option names and allowed ranges
SETTING_RANGES = {
    "speed_pendown": (1, 100),
    "speed_penup": (1, 100),
    "accel": (1, 100),
    "pen_pos_up": (0, 100),
    "pen_rate_lower": (1, 100),
    "pen_rate_raise": (1, 100),
    "pen_delay_down": (0, 5000),
    "model": (1, 7),
    "penlift": (1, 3),  # 1 = the model's default, 2 = standard servo, 3 = narrow-band brushless servo
    "const_speed": (0, 1),  # 1 = constant speed while the pen is down
}
DEFAULT_SETTINGS = {
    "speed_pendown": 20, "speed_penup": 60, "accel": 50, "pen_pos_up": 60,
    "pen_rate_lower": 15, "pen_rate_raise": 60, "pen_delay_down": 0, "model": 1, "penlift": 3, "const_speed": 0,
}


LOST_MESSAGE = ("Lost the AxiDraw - unplugged, or its power switched off. Its position is no longer known: "
                "put the carriage in the home corner, then Connect.")


class PlotterLost(Exception):
    """The plotter disappeared mid-session."""


STREAM_TIMEOUT = 3.0  # Seconds without any part of a live stroke before the pen is lifted

def stroke_length(points):
    return sum(math.dist(points[i - 1], points[i]) for i in range(1, len(points)))


class Plotter:
    """Owns the AxiDraw connection. Every plotter command runs on one worker thread, in order."""

    def __init__(self):
        self.jobs = queue.Queue()
        self.lock = threading.Lock()
        self.ad = None
        self.connected = False
        self.simulate = False
        self.settings = dict(DEFAULT_SETTINGS)
        self.applied = {}             # Settings as last sent to the AxiDraw
        self.current_height = None    # Pen-down height currently applied
        self.paused = False
        self.pause_reason = ""
        self.pause_layer = None       # Layer id, when paused for sharpening
        self.resume_event = threading.Event()
        self.resume_event.set()
        self.cancel_generation = 0    # Bumped by "stop", so queued strokes from before it are skipped
        self.position = (0.0, 0.0)
        self.done_ids = []            # Recently plotted stroke ids, for the app to show progress
        self.length_since_sharpen = {}  # Per layer id, mm drawn since its last sharpening
        self.sharpen_every = {}       # Per layer id, mm between sharpening pauses (0 = never)
        self.total_drawn_mm = 0.0
        self.last_error = ""
        self.stroke = None            # The stroke being drawn, while streaming
        self.height_cap = 100         # Highest safe pen height
        self.stream_activity = 0.0    # When the last piece of a live stroke arrived
        self.last_check = 0.0         # When the plotter's connection was last checked
        self.backlog_mm = 0.0         # Line sent but not drawn yet
        self.rate_mm_s = None         # Measured drawing pace (pen-down mm per second), smoothed
        threading.Thread(target=self._worker, daemon=True).start()

    # ----- called from HTTP threads -----

    def status(self):
        with self.lock:
            return {
                "connected": self.connected, "simulate": self.simulate, "queued": self.jobs.qsize(),
                "paused": self.paused, "pauseReason": self.pause_reason, "pauseLayer": self.pause_layer, "position": self.position,
                "doneIds": list(self.done_ids), "settings": self.settings,
                "lengthSinceSharpen": self.length_since_sharpen, "totalDrawnMm": self.total_drawn_mm,
                "error": self.last_error, "backlogMm": max(0.0, self.backlog_mm),
                "rateMmS": self.rate_mm_s or self.nominal_rate(), "heightCap": self.height_cap,
            }

    def nominal_rate(self):
        """A first guess at the drawing pace before any has been measured - about half the set top speed, as the
        plotter slows for corners."""
        return 0.5 * 220.9 * self.settings["speed_pendown"] / 100.0

    def _measure(self, length, seconds):
        if length < 0.5 or seconds <= 0:
            return
        rate = length / seconds
        with self.lock:
            self.rate_mm_s = rate if self.rate_mm_s is None else 0.7 * self.rate_mm_s + 0.3 * rate

    def _sim_time(self, length, speed):
        """Simulated time to draw a length from standstill to standstill."""
        v = 220.9 * speed / 100.0
        a = 1016.0 * self.settings["accel"] / 100.0
        if length < v * v / a:
            return 2.0 * math.sqrt(length / a)
        return length / v + v / a

    def submit(self, job):
        job["generation"] = self.cancel_generation
        if job["type"] in ("stroke", "extend", "begin"):
            pts = job.get("points", [])
            with self.lock:
                self.backlog_mm += stroke_length([p[:2] for p in pts])
        self.jobs.put(job)

    def pause(self, reason="Paused", layer=None):
        with self.lock:
            self.paused = True
            self.pause_reason = reason
            self.pause_layer = layer
        self.resume_event.clear()

    def resume(self, sharpened_layer=None):
        with self.lock:
            if sharpened_layer is not None:
                self.length_since_sharpen[sharpened_layer] = 0.0
            self.paused = False
            self.pause_reason = ""
            self.pause_layer = None
        self.resume_event.set()

    def stop(self):
        """Drop everything queued, then lift the pen."""
        with self.lock:
            self.cancel_generation += 1
        while True:
            try:
                self.jobs.get_nowait()
            except queue.Empty:
                break
        self.submit({"type": "penup"})
        self.stroke = None
        with self.lock:
            self.backlog_mm = 0.0
        self.resume()

    def set_settings(self, values, height_cap=None):
        with self.lock:
            if height_cap is not None:
                self.height_cap = max(0, min(100, int(height_cap)))
            for key, value in values.items():
                if key in SETTING_RANGES:
                    low, high = SETTING_RANGES[key]
                    self.settings[key] = max(low, min(high, int(value)))
            self.settings["pen_pos_up"] = int(self.cap(self.settings["pen_pos_up"]))  # Pen-up must stay a whole number
        self.submit({"type": "apply_settings"})

    def cap(self, height):
        """Every pen height goes through here: never above the highest safe height (with the spring kit, the point
        before the spring is squashed solid)."""
        return max(0.0, min(float(self.height_cap), round(float(height), 1)))  # Tenths are fine for pen-down

    # ----- worker thread -----

    def _worker(self):
        while True:
            try:
                job = self.jobs.get(timeout=0.5)
            except queue.Empty:
                self._idle_checks()  # Between jobs: the live-stroke watchdog and the connection check
                continue
            if job.get("generation", self.cancel_generation) != self.cancel_generation and job["type"] in ("stroke", "begin", "extend", "end"):
                continue  # Cancelled by stop
            try:
                self._run(job)
                with self.lock:
                    self.last_error = ""
            except Exception as error:  # Keep the worker alive; report the problem to the app
                with self.lock:
                    self.last_error = str(error) if isinstance(error, PlotterLost) else f"{type(error).__name__}: {error}"

    def _run(self, job):
        kind = job["type"]
        if kind in ("begin", "extend", "end"):
            self.stream_activity = time.monotonic()
        if kind in ("stroke", "begin", "pen", "home", "jog", "frame") and self.connected and not self.simulate and not self._plotter_present():
            self._lost_connection()
            raise PlotterLost(LOST_MESSAGE)
        if kind == "connect":
            self._connect(job.get("simulate", False))
        elif kind == "disconnect":
            self._disconnect()
        elif kind == "apply_settings":
            self._apply_settings()
        elif kind == "penup":
            if self.connected and not self.simulate:
                self.ad.penup()
        elif kind == "home":
            self._move_to(0.0, 0.0)
        elif kind == "jog":
            # Pen up, then a step from where the pen is
            x, y = self.position
            self._move_to(x + float(job.get("dx", 0)), y + float(job.get("dy", 0)))
        elif kind == "frame":
            # Trace an outline with the pen up, to show where a drawing will land
            for point in job.get("points", []):
                self._move_to(float(point[0]), float(point[1]))
        elif kind == "stroke":
            self._plot_stroke(job)
        elif kind == "begin":
            if not self._begin_stroke(job):
                self.stroke = None
        elif kind == "extend":
            self._extend_stroke(job["points"])
        elif kind == "end":
            self._end_stroke()
        elif kind == "pen":
            if self.connected and not self.simulate:
                self.ad.pen.phys.z_up = None  # Forget the pen state, so the test always moves the pen
                if job.get("down"):
                    self.ad.options.pen_pos_down = self.cap(job.get("height", 30))
                    self.ad.penup()
                    self.ad.update()
                    self.current_height = self.ad.options.pen_pos_down
                    self.ad.pendown()
                else:
                    self.ad.penup()

    # ----- safety checks -----

    def _idle_checks(self):
        # A live stroke whose pieces stopped arriving (tab closed, browser crashed, connection lost) would leave the
        # pen down on the paper - lift it. The app sends a heartbeat while the stylus is held still, so this only
        # happens when the page has really gone.
        if self.stroke is not None and self.stroke.get("streaming") and time.monotonic() - self.stream_activity > STREAM_TIMEOUT:
            self._end_stroke()
            with self.lock:
                self.last_error = "Lifted the pen: a live stroke stopped arriving (was the page closed or reloaded?)"
        # Every few seconds, check the plotter is still there and powered
        if self.connected and not self.simulate and time.monotonic() - self.last_check > 3.0:
            self.last_check = time.monotonic()
            if not self._plotter_present():
                self._lost_connection()

    def _plotter_present(self):
        """Is the AxiDraw still plugged in, with its motor power on? (The AxiDraw API only logs USB errors, so a
        pulled cable would otherwise go unnoticed.)"""
        try:
            port = self.ad.plot_status.port
            from serial.tools import list_ports
            if port is None or not any(p.device == port.port for p in list_ports.comports()):
                return False
            from plotink import ebb_motion
            return bool(ebb_motion.queryVoltage(port, False))
        except Exception:
            return True  # If the check itself fails, don't cry wolf

    def _lost_connection(self):
        """The plotter vanished or lost power: its position is no longer known, so stop and make the user re-home it."""
        try:
            if self.ad is not None and self.ad.plot_status.port is not None:
                self.ad.plot_status.port.close()
        except Exception:
            pass
        self.ad = None
        self.stroke = None
        while True:
            try:
                self.jobs.get_nowait()
            except queue.Empty:
                break
        with self.lock:
            self.connected = False
            self.backlog_mm = 0.0
            self.cancel_generation += 1
            self.last_error = LOST_MESSAGE
        self.resume_event.set()

    def _connect(self, simulate):
        self._disconnect()
        with self.lock:
            self.simulate = simulate
        if simulate:
            with self.lock:
                self.connected = True
                self.position = (0.0, 0.0)  # As with the real plotter: wherever it is on connecting counts as home
            return
        from pyaxidraw import axidraw  # Imported here so simulate mode works without a plotter attached
        ad = axidraw.AxiDraw()
        ad.interactive()
        ad.options.units = 2  # Millimetres
        for key, value in self.settings.items():
            setattr(ad.options, key, value)
        ad.options.pen_pos_up = int(self.cap(self.settings["pen_pos_up"]))
        ad.options.pen_pos_down = self.cap(min(ad.options.pen_pos_down, ad.options.pen_pos_up))
        if not ad.connect():
            raise RuntimeError("Couldn't connect to the AxiDraw - is it plugged in and powered?")
        self.ad = ad
        self.applied = dict(self.settings)
        self.current_height = None
        with self.lock:
            self.connected = True
            self.position = (0.0, 0.0)

    def _disconnect(self):
        if self.ad is not None:
            try:
                self.ad.penup()
                self.ad.moveto(0, 0)
                self.ad.disconnect()
            finally:
                self.ad = None
        with self.lock:
            self.connected = False

    def _apply_settings(self):
        if not self.connected or self.simulate or self.settings == self.applied:
            return
        for key, value in self.settings.items():
            setattr(self.ad.options, key, value)
        self.ad.penup()
        self.ad.update()
        self.applied = dict(self.settings)

    def _move_to(self, x, y):
        """A pen-up move. The AxiDraw stops at the edges of its travel, so the position is read back afterwards."""
        if not self.connected:
            raise RuntimeError("Not connected - choose Connect or Simulate first")
        if self.simulate:
            x, y = max(0.0, x), max(0.0, y)
        else:
            self.ad.moveto(x, y)
            x, y = self.ad.current_pos()
        with self.lock:
            self.position = (round(x, 3), round(y, 3))

    def _servo_command(self, height):
        """Moves the pen servo to a pen-down height right away, without pausing the motion - for pressure changes mid-stroke."""
        params, options = self.ad.params, self.ad.options
        if getattr(options, "penlift", 1) == 3:
            low, high, sweep, period, pin = params.nb_servo_min, params.nb_servo_max, params.nb_servo_sweep_time, 0.03, params.nb_servo_pin
        else:
            low, high, sweep, period, pin = params.servo_min, params.servo_max, params.servo_sweep_time, 0.24, params.servo_pin
        position = int(round(low + (high - low) * height / 100.0))
        rate = max(1, int(round((high - low) * period / sweep * self.settings["pen_rate_lower"])))
        self.ad.usb_command(f"S2,{position},{pin},{rate},0\r")

    def _begin_stroke(self, job, lower=True):
        """Waits out any sharpening pause, sets the stroke's height and speed, then puts the pen down at its first point."""
        if not self.connected:
            raise RuntimeError("Not connected - choose Connect or Simulate first")
        layer = job.get("layer", "")
        allowance = self.sharpen_every.get(layer, 0)
        drawn = self.length_since_sharpen.get(layer, 0.0)
        if allowance > 0 and drawn > 0 and drawn + job.get("expectedLength", 0.0) > allowance:
            if not self.simulate:
                self.ad.penup()
            self.pause(f"Sharpen the pencil for \"{job.get('layerName') or layer}\"", layer)
        self.resume_event.wait()
        if job.get("generation") != self.cancel_generation:
            return False  # Stopped while paused

        point = job["points"][0]
        height = self.cap(point[2] if len(point) > 2 else job.get("height", 30))
        speed = int(job.get("speed") or self.settings["speed_pendown"])
        self.stroke = {"id": job.get("id"), "layer": layer, "height": height, "vary": bool(job.get("vary")), "speed": speed, "last": tuple(point[:2]),
                       "streaming": job.get("type") == "begin"}
        if not self.simulate:
            if height != self.current_height or speed != self.ad.options.speed_pendown:
                self.ad.options.pen_pos_down = height
                self.ad.options.speed_pendown = speed
                self.ad.penup()
                self.ad.update()  # Only while the pen is up, so the new height is where it lands
                self.current_height = height
            if lower:
                self.ad.moveto(point[0], point[1])
                self.ad.pendown()
        with self.lock:
            self.position = tuple(point[:2])
        return True

    def _extend_stroke(self, points):
        stroke = self.stroke
        if stroke is None:
            with self.lock:
                self.backlog_mm -= stroke_length([p[:2] for p in points])
            return
        started, total = time.monotonic(), 0.0
        for point in points:
            x, y = point[0], point[1]
            length = math.dist(stroke["last"], (x, y))
            if self.simulate:
                time.sleep(min(1.0, self._sim_time(length, stroke["speed"])))
            else:
                if stroke["vary"] and len(point) > 2:
                    height = self.cap(point[2])
                    if abs(height - stroke["height"]) >= 0.5:
                        self._servo_command(height)
                        stroke["height"] = height
                self.ad.lineto(x, y)
            stroke["last"] = (x, y)
            with self.lock:
                self.position = (x, y)
                self.length_since_sharpen[stroke["layer"]] = self.length_since_sharpen.get(stroke["layer"], 0.0) + length
                self.total_drawn_mm += length
                self.backlog_mm -= length
            total += length
        self._measure(total, time.monotonic() - started)

    def _end_stroke(self):
        if self.stroke is None:
            return
        if not self.simulate:
            self.ad.penup()
            if self.stroke["vary"]:
                self.current_height = None  # The servo was moved directly, so the next stroke re-applies its height
        with self.lock:
            self.done_ids.append(self.stroke["id"])
            self.done_ids = self.done_ids[-2000:]
        self.stroke = None

    def _plot_stroke(self, job):
        points = job["points"]
        length = stroke_length([p[:2] for p in points])
        if len(points) < 2:
            with self.lock:
                self.backlog_mm -= length
            return
        job["expectedLength"] = length
        if job.get("vary"):
            # Pressure changes along the stroke need the pen moved point by point
            if self._begin_stroke(job):
                self._extend_stroke(points[1:])
                self._end_stroke()
            return
        # One height for the whole stroke: plot it as a single planned path, which keeps its speed through gentle
        # curves instead of stopping at every point
        if not self._begin_stroke(job, lower=False):
            with self.lock:
                self.backlog_mm -= length
            return
        started = time.monotonic()
        if self.simulate:
            time.sleep(min(5.0, self._sim_time(length, self.stroke["speed"])))
        else:
            self.ad.draw_path([p[:2] for p in points])
        self._measure(length, time.monotonic() - started)
        layer = self.stroke["layer"]
        with self.lock:
            self.position = tuple(points[-1][:2])
            self.length_since_sharpen[layer] = self.length_since_sharpen.get(layer, 0.0) + length
            self.total_drawn_mm += length
            self.backlog_mm -= length
        self._end_stroke()


PLOTTER = Plotter()
ALLOWED_HOSTS = set()  # Host headers the API answers to, set from the port in main()


def stroke_job(stroke):
    return {"id": stroke.get("id"), "layer": str(stroke.get("layer", "")), "layerName": str(stroke.get("layerName", "")),
            "points": [[float(v) for v in point[:3]] for point in stroke.get("points", [])],
            "speed": stroke.get("speed"), "vary": bool(stroke.get("vary")), "height": stroke.get("height", 30)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Quiet

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self, post):
        """Only the app's own page may use the API. Without this, any website open in the browser could send the
        plotter commands (the server only listens on this computer, but the browser is on it too)."""
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return False  # Guards against DNS rebinding
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {f"http://{h}" for h in ALLOWED_HOSTS}:
            return False
        # A JSON content type can't be sent cross-site without the browser asking first, which this server never allows
        return not post or self.headers.get("Content-Type", "").split(";")[0].strip() == "application/json"

    def do_GET(self):
        if not self._allowed(post=False):
            return self._send_json({"error": "Not allowed"}, 403)
        if self.path == "/api/status":
            return self._send_json(PLOTTER.status())
        path = self.path.split("?")[0]
        path = "/index.html" if path == "/" else path
        file_path = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not file_path.startswith(WEB_DIR + os.sep) or not os.path.isfile(file_path):
            self.send_error(404)
            return
        with open(file_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file_path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self._allowed(post=True):
            return self._send_json({"error": "Not allowed"}, 403)
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send_json({"error": "Bad request"}, 400)

        route = self.path
        if route == "/api/connect":
            PLOTTER.submit({"type": "connect", "simulate": bool(data.get("simulate"))})
        elif route == "/api/disconnect":
            PLOTTER.submit({"type": "disconnect"})
        elif route == "/api/settings":
            PLOTTER.set_settings(data.get("settings", {}), data.get("heightCap"))
            for layer, mm in data.get("sharpenEvery", {}).items():
                PLOTTER.sharpen_every[layer] = max(0.0, float(mm))
        elif route == "/api/strokes":
            # Whole strokes: {strokes: [{id, layer, layerName, points: [[x, y, height], ...], speed, vary}]}
            for stroke in data.get("strokes", []):
                PLOTTER.submit(dict(stroke_job(stroke), type="stroke"))
        elif route == "/api/stream":
            # A stroke while it's drawn: {phase: begin|extend|end, ...} - begin and extend carry points
            phase = data.get("phase")
            if phase in ("begin", "extend", "end"):
                PLOTTER.submit(dict(stroke_job(data), type=phase))
        elif route == "/api/pen":
            PLOTTER.submit({"type": "pen", "down": bool(data.get("down")), "height": data.get("height", 30)})
        elif route == "/api/pause":
            PLOTTER.pause("Paused")
        elif route == "/api/resume":
            PLOTTER.resume(data.get("sharpenedLayer"))
        elif route == "/api/stop":
            PLOTTER.stop()
        elif route == "/api/home":
            PLOTTER.submit({"type": "home"})
        elif route == "/api/jog":
            PLOTTER.submit({"type": "jog", "dx": float(data.get("dx", 0)), "dy": float(data.get("dy", 0))})
        elif route == "/api/frame":
            PLOTTER.submit({"type": "frame", "points": [[float(x), float(y)] for x, y in data.get("points", [])][:1000]})
        elif route == "/api/reset_sharpen":
            with PLOTTER.lock:
                PLOTTER.length_since_sharpen.pop(str(data.get("layer")), None)
        else:
            return self._send_json({"error": "Unknown route"}, 404)
        self._send_json(PLOTTER.status())


def already_running(url):
    """Whether an AxiDraw Live server is already answering at this address."""
    import urllib.request
    try:
        with urllib.request.urlopen(url + "/api/status", timeout=2) as response:
            return "connected" in json.loads(response.read())
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(description="AxiDraw Live - draw with a tablet, plot as you go.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="don't open the app in the browser")
    args = parser.parse_args()
    ALLOWED_HOSTS.update({f"127.0.0.1:{args.port}", f"localhost:{args.port}"})
    url = f"http://127.0.0.1:{args.port}"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        # The port is taken - most likely AxiDraw Live is already running, so just open it
        if already_running(url):
            print(f"AxiDraw Live is already running at {url} - opening it.")
            if not args.no_browser:
                webbrowser.open(url)
            return
        print(f"Port {args.port} is in use by another program. Try:  server.py --port {args.port + 1}")
        sys.exit(1)
    print(f"AxiDraw Live running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        PLOTTER.jobs.put({"type": "disconnect"})
        time.sleep(0.5)


if __name__ == "__main__":
    main()
