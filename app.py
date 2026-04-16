import hashlib
import os
import re
import subprocess
import tempfile
import time
from datetime import timedelta
from functools import wraps

import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, session, send_file

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret-key")
app.permanent_session_lifetime = timedelta(days=1)

CAMERA_HOST = os.getenv("CAMERA_HOST", "192.168.1.100:80")
CAMERA_BASE = f"http://{CAMERA_HOST}"

VIDEO_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".video_cache")
os.makedirs(VIDEO_CACHE_DIR, exist_ok=True)

VIDEO_CACHE_MAX_BYTES = 500 * 1024 * 1024  # 500 MB
VIDEO_CACHE_MAX_AGE_DAYS = 7


def evict_video_cache():
    """Remove cached files older than MAX_AGE_DAYS, then enforce MAX_BYTES limit (LRU)."""
    now = time.time()
    max_age = VIDEO_CACHE_MAX_AGE_DAYS * 86400

    entries = []
    for fname in os.listdir(VIDEO_CACHE_DIR):
        if not fname.endswith(".mp4"):
            continue
        path = os.path.join(VIDEO_CACHE_DIR, fname)
        try:
            st = os.stat(path)
        except OSError:
            continue
        if now - st.st_mtime > max_age:
            try:
                os.unlink(path)
            except OSError:
                pass
        else:
            entries.append((st.st_mtime, st.st_size, path))

    # Enforce size limit: remove oldest (by mtime) until under budget
    entries.sort()  # oldest first
    total = sum(e[1] for e in entries)
    for mtime, size, path in entries:
        if total <= VIDEO_CACHE_MAX_BYTES:
            break
        try:
            os.unlink(path)
            total -= size
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Camera helpers
# ---------------------------------------------------------------------------

def camera_get(path, creds, timeout=10):
    """GET a path on the camera with Basic Auth. Returns Response or raises."""
    url = f"{CAMERA_BASE}{path}"
    resp = requests.get(url, auth=(creds["username"], creds["password"]), timeout=timeout)
    resp.raise_for_status()
    return resp


def parse_directory_listing(html):
    """Parse camera's HTML directory listing. Returns list of dicts with name, modified, size."""
    entries = []
    pattern = re.compile(
        r'<a href="([^"]+)">[^<]+</a>\s*</td><td[^>]*>&nbsp;([^<]*)</td><td[^>]*>&nbsp;&nbsp;([^<]*)</td>'
    )
    for href, modified, size in pattern.findall(html):
        name = href.rstrip("/").split("/")[-1]
        if name in ("..", "") or href.endswith("/.."):
            continue
        is_dir = href.endswith("/")
        entries.append({
            "name": name,
            "href": href,
            "modified": modified.strip(),
            "size": size.strip(),
            "is_dir": is_dir,
        })
    return entries


def parse_image_filename(name):
    """Parse AYYMMDDHHMMSSCC.jpg → {time, channel}.
    Example: A26041613315700.jpg → time='13:31:57', channel=0
    """
    m = re.match(r"[AP](\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(jpg|jpeg)$", name, re.IGNORECASE)
    if not m:
        return None
    yy, mo, dd, hh, mi, ss, ch = m.groups()[:7]
    return {
        "time": f"{hh}:{mi}:{ss}",
        "channel": int(ch),
        "datetime": f"20{yy}-{mo}-{dd}T{hh}:{mi}:{ss}",
    }


def strip_hxvf_wrapper(data: bytes) -> bytes:
    """Strip HiXVision HXVS/HXVF proprietary wrapper from .264 Annex B stream.
    The camera wraps each NAL unit with a 16-byte HXVF frame header. These headers
    confuse the H.264 decoder causing all-gray output. Returns clean Annex B stream."""
    if not data.startswith(b'HXVS') and b'HXVF' not in data[:64]:
        return data  # Not wrapped, pass through
    output = bytearray()
    i = 0
    while i < len(data):
        idx = data.find(b'HXVF', i)
        if idx == -1:
            break
        nal_start = idx + 16  # HXVF header is always 16 bytes
        length = int.from_bytes(data[idx + 4:idx + 8], 'little')
        nal_end = nal_start + length
        if data[nal_start:nal_start + 4] == b'\x00\x00\x00\x01':
            output.extend(data[nal_start:nal_end])
        i = idx + 1
    return bytes(output) if output else data


def parse_record_filename(name):
    """Parse XYYMMDD_HHMMSS_HHMMSS.{264,265} → {start, end, type, ext}.
    Example: A260416_133158_133212.264 → start='13:31:58', end='13:32:12', type='alert'
    End time '999999' means recording is still in progress.
    """
    m = re.match(r"([AP])(\d{6})_(\d{6})_(\d{6})\.(264|265)$", name, re.IGNORECASE)
    if not m:
        return None
    prefix, date_s, start_s, end_s, ext = m.groups()
    yy, mo, dd = date_s[:2], date_s[2:4], date_s[4:]

    def fmt_time(s):
        return f"{s[0:2]}:{s[2:4]}:{s[4:]}"

    def total_secs(t):
        h, mi, s = int(t[:2]), int(t[3:5]), int(t[6:])
        return h * 3600 + mi * 60 + s

    start_time = fmt_time(start_s)
    ongoing = end_s == "999999"
    end_time = start_time if ongoing else fmt_time(end_s)

    if ongoing:
        duration = None
    else:
        duration = total_secs(end_time) - total_secs(start_time)
        if duration < 0:
            duration += 86400

    return {
        "start": start_time,
        "end": end_time,
        "ongoing": ongoing,
        "duration": duration,
        "type": "alert" if prefix.upper() == "A" else "periodic",
        "ext": ext,
        "date": f"20{yy}-{mo}-{dd}",
        "start_dt": f"20{yy}-{mo}-{dd}T{start_time}",
    }


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "username" not in session:
            return jsonify({"error": "Not authenticated"}), 401
        return f(*args, **kwargs)
    return decorated


def get_creds():
    return {"username": session["username"], "password": session["password"]}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    username = (data or {}).get("username", "").strip()
    password = (data or {}).get("password", "")
    if not username:
        return jsonify({"error": "Username required"}), 400
    try:
        camera_get("/sd/", {"username": username, "password": password})
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Cannot reach camera"}), 503
    except requests.exceptions.HTTPError as e:
        if e.response.status_code in (401, 403):
            return jsonify({"error": "Invalid credentials"}), 401
        return jsonify({"error": f"Camera error: {e.response.status_code}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    session.permanent = True
    session["username"] = username
    session["password"] = password
    return jsonify({"ok": True})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/dates")
@require_auth
def api_dates():
    try:
        resp = camera_get("/sd/", get_creds())
    except Exception as e:
        return jsonify({"error": str(e)}), 502
    entries = parse_directory_listing(resp.text)
    dates = sorted(
        [e["name"] for e in entries if e["is_dir"] and re.match(r"^\d{8}$", e["name"])],
        reverse=True,
    )
    return jsonify({"dates": dates})


@app.route("/api/events/<date>")
@require_auth
def api_events(date):
    if not re.match(r"^\d{8}$", date):
        return jsonify({"error": "Invalid date"}), 400
    creds = get_creds()

    try:
        resp = camera_get(f"/sd/{date}/", creds)
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            # Date directory doesn't exist on camera — return empty results
            return jsonify({"date": date, "images": [], "records": []})
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    day_entries = parse_directory_listing(resp.text)

    images_dirs = sorted(
        [e["name"] for e in day_entries if e["is_dir"] and e["name"].startswith("images")]
    )
    record_dirs = sorted(
        [e["name"] for e in day_entries if e["is_dir"] and e["name"].startswith("record")]
    )

    images = []
    for img_dir in images_dirs:
        try:
            r = camera_get(f"/sd/{date}/{img_dir}/", creds)
            for entry in parse_directory_listing(r.text):
                if entry["is_dir"]:
                    continue
                parsed = parse_image_filename(entry["name"])
                if parsed:
                    images.append({
                        "name": entry["name"],
                        "path": f"{img_dir}/{entry['name']}",
                        "time": parsed["time"],
                        "channel": parsed["channel"],
                        "datetime": parsed["datetime"],
                        "size": entry["size"],
                    })
        except Exception:
            continue

    records = []
    for rec_dir in record_dirs:
        try:
            r = camera_get(f"/sd/{date}/{rec_dir}/", creds)
            for entry in parse_directory_listing(r.text):
                if entry["is_dir"]:
                    continue
                parsed = parse_record_filename(entry["name"])
                if parsed:
                    records.append({
                        "name": entry["name"],
                        "path": f"{rec_dir}/{entry['name']}",
                        "start": parsed["start"],
                        "end": parsed["end"],
                        "ongoing": parsed["ongoing"],
                        "duration": parsed["duration"],
                        "type": parsed["type"],
                        "ext": parsed["ext"],
                        "size": entry["size"],
                        "start_dt": parsed["start_dt"],
                    })
        except Exception:
            continue

    images.sort(key=lambda x: x["datetime"])
    records.sort(key=lambda x: x["start_dt"])

    return jsonify({"date": date, "images": images, "records": records})


@app.route("/api/thumbnail/<date>/<path:filepath>")
@require_auth
def api_thumbnail(date, filepath):
    if not re.match(r"^\d{8}$", date):
        return jsonify({"error": "Invalid date"}), 400
    creds = get_creds()
    try:
        resp = camera_get(f"/sd/{date}/{filepath}", creds)
        return Response(resp.content, content_type="image/jpeg")
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/video/<date>/<path:filepath>")
@require_auth
def api_video(date, filepath):
    """Fetch raw video from camera, transcode to MP4 via ffmpeg, serve with range support.
    Transcoded files are cached on disk so range requests (video seeking) work correctly."""
    if not re.match(r"^\d{8}$", date):
        return jsonify({"error": "Invalid date"}), 400
    creds = get_creds()
    url = f"{CAMERA_BASE}/sd/{date}/{filepath}"

    base_name = filepath.rsplit("/", 1)[-1]
    out_name = re.sub(r"\.(264|265)$", ".mp4", base_name, flags=re.IGNORECASE)

    # Use a cache keyed by date+path so range requests reuse the same file
    cache_key = hashlib.md5(f"{date}/{filepath}".encode()).hexdigest()
    cache_path = os.path.join(VIDEO_CACHE_DIR, cache_key + ".mp4")

    if not os.path.exists(cache_path):
        evict_video_cache()
        ext = filepath.rsplit(".", 1)[-1].lower() if "." in filepath else ""
        input_fmt = "hevc" if ext == "265" else "h264"

        try:
            cam_resp = requests.get(
                url,
                auth=(creds["username"], creds["password"]),
                timeout=60,
            )
            cam_resp.raise_for_status()
        except requests.exceptions.HTTPError as e:
            return jsonify({"error": f"Camera error: {e.response.status_code}"}), 502
        except Exception as e:
            return jsonify({"error": str(e)}), 502

        # For .264 files: strip HXVS/HXVF proprietary camera wrapper before decoding.
        # The wrapper inserts 16-byte frame headers between NAL units which corrupt
        # the H.264 decoder, causing all-gray output.
        video_data = cam_resp.content
        if input_fmt == "h264":
            video_data = strip_hxvf_wrapper(video_data)

        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4", dir=VIDEO_CACHE_DIR)
        os.close(tmp_fd)
        try:
            try:
                ffmpeg_cmd = [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-f", input_fmt,
                    "-i", "pipe:0",
                    "-c:v", "libx264",
                    "-preset", "ultrafast",
                    "-crf", "28",
                    "-vf", "setpts=2*PTS",
                    "-movflags", "+faststart",
                    tmp_path,
                ]
                result = subprocess.run(
                    ffmpeg_cmd,
                    input=video_data,
                    capture_output=True,
                    timeout=120,
                )
            except subprocess.TimeoutExpired:
                return jsonify({"error": "Video conversion timeout"}), 504

            if result.returncode != 0 or os.path.getsize(tmp_path) == 0:
                stderr = result.stderr.decode(errors="replace")
                return jsonify({"error": "Video conversion failed", "details": stderr}), 500

            os.replace(tmp_path, cache_path)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    return send_file(
        cache_path,
        mimetype="video/mp4",
        as_attachment=False,
        download_name=out_name,
        conditional=True,
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5002))
    app.run(host="0.0.0.0", port=port, debug=True)
