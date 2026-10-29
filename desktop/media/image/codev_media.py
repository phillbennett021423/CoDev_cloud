#!/usr/bin/env python3
"""CoDev's video and audio editor, run inside the codev-media Docker image.

Agents describe an edit as a list of plain steps ("clean_speech", then
"add_music" at 15% volume...) and this turns them into FFmpeg, Whisper
(faster-whisper), Demucs and DeepFilterNet runs. Every path is relative to the
media folder mounted at /media; nothing outside it is read or written.

  codev_media.py info FILE
  codev_media.py edit SPEC.json        {"input", "steps": [...], "output": "name without extension"}
  codev_media.py transcribe SPEC.json  {"input", "language"?, "output"?}
  codev_media.py find SPEC.json        {"input", "query", "language"?}
  codev_media.py separate SPEC.json    {"input", "output", "stems": "vocals" | "all"}
  codev_media.py download-models       (while the image is built)

Progress goes to stderr; the last line on stdout is the JSON result.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

MEDIA = os.environ.get("CODEV_MEDIA_DIR", "/media")
WHISPER_DIR = os.environ.get("CODEV_WHISPER_DIR", "/opt/models/whisper")
WHISPER_MODEL = os.environ.get("CODEV_WHISPER_MODEL", "small")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
VIDEO_CODEC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
AUDIO_CODEC = ["-c:a", "aac", "-b:a", "192k"]
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".weba"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
ASPECTS = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}
# Where text, captions and logos go.
POSITIONS = {"top", "center", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"}
DF_CHUNK_SECONDS = 120


class MediaError(Exception):
    pass


def say(text):
    print(text, file=sys.stderr, flush=True)


# ---------- paths ----------

def media_path(rel, must_exist=True):
    """An absolute path inside MEDIA for a name the agent gave, never outside it."""
    if not isinstance(rel, str) or not rel.strip():
        raise MediaError("a file name is missing")
    clean = os.path.normpath(os.path.join(MEDIA, rel.strip().lstrip("/\\").replace("\\", "/")))
    if clean != MEDIA and not clean.startswith(MEDIA + os.sep):
        raise MediaError(f"'{rel}' is outside the media folder")
    if must_exist and not os.path.isfile(clean):
        raise MediaError(f"there is no file named '{rel}' in the media folder")
    return clean


def shown(path):
    return os.path.relpath(path, MEDIA).replace(os.sep, "/")


def seconds(value, name="time"):
    """12, "12.5", "1:05", "00:01:05.5" -> seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        raise MediaError(f"{name} is missing")
    try:
        parts = [float(p) for p in text.split(":")]
    except ValueError:
        raise MediaError(f"{name} '{value}' isn't a time like 75, 1:15 or 0:01:15")
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def stamp(t, comma=False):
    ms = int(round(max(0.0, t) * 1000))
    h, rest = divmod(ms, 3600000)
    m, rest = divmod(rest, 60000)
    s, ms = divmod(rest, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{',' if comma else '.'}{ms:03d}"


# ---------- running tools ----------

def run(cmd, what):
    say(f"[{what}] " + " ".join(cmd[:6]) + (" ..." if len(cmd) > 6 else ""))
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or proc.stdout or "").strip().splitlines()[-8:])
        raise MediaError(f"{what} failed: {tail or 'exit code ' + str(proc.returncode)}")
    return proc.stdout


def ffmpeg(args, what="FFmpeg"):
    return run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], what)


def probe(path):
    out = run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path], "ffprobe")
    data = json.loads(out or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float((data.get("format") or {}).get("duration") or 0)
    info = {"duration": round(duration, 2), "has_video": bool(video), "has_audio": bool(audio),
            "size_bytes": int((data.get("format") or {}).get("size") or 0)}
    if video:
        w, h = int(video.get("width") or 0), int(video.get("height") or 0)
        rotation = abs(int(((video.get("tags") or {}).get("rotate")) or 0))
        for side in video.get("side_data_list") or []:
            if "rotation" in side:
                rotation = abs(int(side["rotation"]))
        if rotation in (90, 270):
            w, h = h, w
        rate = str(video.get("avg_frame_rate") or "0/1")
        num, _, den = rate.partition("/")
        fps = float(num) / float(den) if den and float(den) else 0
        info.update({"width": w, "height": h, "fps": round(fps, 2), "video_codec": video.get("codec_name")})
    if audio:
        info.update({"audio_codec": audio.get("codec_name"), "sample_rate": int(audio.get("sample_rate") or 0),
                     "channels": int(audio.get("channels") or 0)})
    return info


class Job:
    """Temporary files for one edit, in the media folder (not /tmp, which is small)."""

    def __init__(self):
        root = os.path.join(MEDIA, ".work")
        os.makedirs(root, exist_ok=True)
        self.dir = tempfile.mkdtemp(prefix="job-", dir=root)
        self.count = 0
        self.notes = []
        self.extras = []

    def temp(self, ext):
        self.count += 1
        return os.path.join(self.dir, f"step{self.count:02d}{ext}")

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def out_ext(info):
    return ".mp4" if info["has_video"] else ".m4a"


def encode_args(info):
    return (VIDEO_CODEC if info["has_video"] else ["-vn"]) + (AUDIO_CODEC if info["has_audio"] else ["-an"]) + ["-movflags", "+faststart"]


def need_video(info, step):
    if not info["has_video"]:
        raise MediaError(f"{step} needs a video, and this file is audio only")


def need_audio(info, step):
    if not info["has_audio"]:
        raise MediaError(f"{step} needs sound, and this file has none")


# ---------- Whisper ----------

_whisper = None


def whisper_model():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        say(f"[Whisper] loading the {WHISPER_MODEL} model")
        threads = max(1, min(8, os.cpu_count() or 4))
        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=WHISPER_DIR,
                                local_files_only=True, cpu_threads=threads)
    return _whisper


def transcript_of(path, language=None):
    """Segments with word times, cached per file so captions and finds reuse it."""
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}|{language or ''}|{WHISPER_MODEL}".encode()).hexdigest()[:16]
    cache_dir = os.path.join(MEDIA, ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache = os.path.join(cache_dir, f"transcript-{key}.json")
    if os.path.isfile(cache):
        with open(cache, encoding="utf-8") as f:
            return json.load(f)
    wav = os.path.join(cache_dir, f"audio-{key}.wav")
    ffmpeg(["-i", path, "-vn", "-ac", "1", "-ar", "16000", wav], "Extracting the sound for Whisper")
    try:
        say("[Whisper] listening (about a quarter of the clip's length on a typical PC)")
        segments, info = whisper_model().transcribe(wav, language=language or None, word_timestamps=True, vad_filter=True)
        result = {"language": info.language, "segments": []}
        for seg in segments:
            result["segments"].append({
                "start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip(),
                "words": [{"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word.strip()} for w in (seg.words or [])]
            })
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass
    with open(cache, "w", encoding="utf-8") as f:
        json.dump(result, f)
    return result


def caption_lines(transcript, words_per_line):
    """Short caption chunks from the word times (social-video style), or whole segments."""
    lines = []
    for seg in transcript["segments"]:
        words = seg.get("words") or []
        if not words_per_line or not words:
            lines.append((seg["start"], seg["end"], seg["text"]))
            continue
        for i in range(0, len(words), words_per_line):
            chunk = words[i:i + words_per_line]
            lines.append((chunk[0]["start"], chunk[-1]["end"], " ".join(w["word"] for w in chunk)))
    # No overlaps, and no flash shorter than a few frames.
    fixed = []
    for i, (a, b, text) in enumerate(lines):
        if i + 1 < len(lines):
            b = min(max(b, a + 0.3), lines[i + 1][0])
        fixed.append((a, max(b, a + 0.3), text))
    return fixed


def write_srt(lines, path):
    with open(path, "w", encoding="utf-8") as f:
        for i, (a, b, text) in enumerate(lines, 1):
            f.write(f"{i}\n{stamp(a, True)} --> {stamp(b, True)}\n{text}\n\n")


# ---------- DeepFilterNet and Demucs ----------

def deepfilter(wav_in, wav_out, atten_lim_db=None):
    import numpy as np
    import soundfile as sf
    import torch
    from df.enhance import enhance, init_df
    say("[DeepFilterNet] removing background noise from the speech")
    model, state, _ = init_df(log_level="ERROR", log_file=None)  # the model folder is read-only
    audio, sr = sf.read(wav_in, dtype="float32", always_2d=True)
    audio = audio.T  # channels x samples
    chunk = DF_CHUNK_SECONDS * sr
    overlap = sr  # one second, crossfaded, so chunk edges don't click
    out = np.zeros_like(audio)
    start = 0
    while start < audio.shape[1]:
        end = min(audio.shape[1], start + chunk)
        lo = max(0, start - overlap)
        piece = enhance(model, state, torch.from_numpy(np.ascontiguousarray(audio[:, lo:end])), atten_lim_db=atten_lim_db).numpy()
        if lo < start:
            n = start - lo
            ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
            out[:, lo:start] = out[:, lo:start] * (1 - ramp) + piece[:, :n] * ramp
            out[:, start:end] = piece[:, n:]
        else:
            out[:, start:end] = piece
        start = end
    sf.write(wav_out, out.T, sr)


def demucs_split(path, job, two_stems=True):
    """{stem name: wav path}: vocals and no_vocals, or vocals, drums, bass and other."""
    wav = job.temp(".wav")
    ffmpeg(["-i", path, "-vn", "-ac", "2", "-ar", "44100", wav], "Extracting the sound for Demucs")
    outdir = os.path.join(job.dir, "demucs")
    say("[Demucs] separating the voices from the music and other sounds (about as long as the clip on a typical PC)")
    cmd = [sys.executable, "-m", "demucs", "-n", "htdemucs", "-d", "cpu", "-o", outdir]
    if two_stems:
        cmd += ["--two-stems", "vocals"]
    run(cmd + [wav], "Demucs")
    folder = os.path.join(outdir, "htdemucs", os.path.splitext(os.path.basename(wav))[0])
    return {os.path.splitext(n)[0]: os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".wav")}


def with_new_audio(cur, info, wav, job):
    """The clip with its sound replaced by wav (same length)."""
    out = job.temp(out_ext(info))
    if info["has_video"]:
        ffmpeg(["-i", cur, "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *AUDIO_CODEC, "-shortest", "-movflags", "+faststart", out], "Putting the new sound in")
    else:
        ffmpeg(["-i", wav, "-vn", *AUDIO_CODEC, out], "Encoding the sound")
    return out


# ---------- steps ----------

def keep_ranges(cur, info, ranges, job):
    """Only these (start, end) parts, joined in order."""
    if not ranges:
        raise MediaError("no parts are left to keep")
    parts, labels = [], ""
    for i, (a, b) in enumerate(ranges):
        if info["has_video"]:
            parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]")
            labels += f"[v{i}]"
        if info["has_audio"]:
            parts.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[a{i}]")
            labels += f"[a{i}]"
    v, a = int(info["has_video"]), int(info["has_audio"])
    outs = ("[v]" if v else "") + ("[a]" if a else "")
    graph = ";".join(parts) + f";{labels}concat=n={len(ranges)}:v={v}:a={a}{outs}"
    out = job.temp(out_ext(info))
    maps = (["-map", "[v]"] if v else []) + (["-map", "[a]"] if a else [])
    ffmpeg(["-i", cur, "-filter_complex", graph, *maps, *encode_args(info), out], "Cutting")
    return out


def parse_ranges(step, info):
    raw = step.get("ranges") or ([{"start": step.get("start", 0), "end": step.get("end")}] if "start" in step or "end" in step else [])
    ranges = []
    for r in raw:
        if isinstance(r, (list, tuple)):
            r = {"start": r[0], "end": r[1] if len(r) > 1 else None}
        a = seconds(r.get("start", 0), "start")
        b = seconds(r["end"], "end") if r.get("end") not in (None, "") else info["duration"]
        a, b = max(0.0, a), min(info["duration"] or b, b)
        if b <= a:
            raise MediaError(f"the part {a:g}s to {b:g}s is empty (the clip is {info['duration']:g}s long)")
        ranges.append((a, b))
    if not ranges:
        raise MediaError("give start and end, or ranges: [{start, end}, ...]")
    return sorted(ranges)


def step_trim(cur, info, step, job):
    return keep_ranges(cur, info, parse_ranges(step, info)[:1], job)


def step_keep(cur, info, step, job):
    return keep_ranges(cur, info, parse_ranges(step, info), job)


def step_cut(cur, info, step, job):
    keep, at = [], 0.0
    for a, b in parse_ranges(step, info):
        if a > at:
            keep.append((at, a))
        at = max(at, b)
    if at < info["duration"]:
        keep.append((at, info["duration"]))
    return keep_ranges(cur, info, [r for r in keep if r[1] - r[0] > 0.05], job)


def normalized_inputs(paths, job, width, height):
    """Each clip re-encoded to the same size, frame rate and sound format, ready to join."""
    done = []
    for p in paths:
        info = probe(p)
        out = job.temp(".mp4")
        args = ["-i", p]
        if not info["has_audio"]:
            args += ["-f", "lavfi", "-t", str(max(0.1, info["duration"])), "-i", "anullsrc=r=48000:cl=stereo"]
        vf = (f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
              "setsar=1,fps=30,format=yuv420p")
        if info["has_video"]:
            args += ["-map", "0:v:0", "-vf", vf]
        else:
            raise MediaError(f"{shown(p)} has no picture, so it can't be joined to a video (use voiceover or add_music for sound)")
        args += ["-map", "0:a:0" if info["has_audio"] else "1:a:0", "-ar", "48000", "-ac", "2", *VIDEO_CODEC, *AUDIO_CODEC, "-shortest", out]
        ffmpeg(args, f"Preparing {os.path.basename(p)} to join")
        done.append(out)
    return done


def step_join(cur, info, step, job):
    others = [media_path(f) for f in (step.get("files") or [])]
    if not others:
        raise MediaError("join needs files: the clips to add after this one")
    paths = ([media_path(f) for f in step["before"]] if step.get("before") else []) + [cur] + others
    if not info["has_video"]:
        out = job.temp(".m4a")
        graph = "".join(f"[{i}:a]" for i in range(len(paths))) + f"concat=n={len(paths)}:v=0:a=1[a]"
        ffmpeg([x for p in paths for x in ("-i", p)] + ["-filter_complex", graph, "-map", "[a]", *AUDIO_CODEC, out], "Joining")
        return out
    width, height = info["width"] - info["width"] % 2, info["height"] - info["height"] % 2
    parts = normalized_inputs(paths, job, width, height)
    listing = job.temp(".txt")
    with open(listing, "w") as f:
        f.writelines(f"file '{p}'\n" for p in parts)
    out = job.temp(".mp4")
    ffmpeg(["-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", "-movflags", "+faststart", out], "Joining")
    return out


def atempo_chain(factor):
    parts = []
    while factor > 2.0:
        parts.append("atempo=2.0")
        factor /= 2.0
    while factor < 0.5:
        parts.append("atempo=0.5")
        factor /= 0.5
    parts.append(f"atempo={factor:.4f}")
    return ",".join(parts)


def step_speed(cur, info, step, job):
    factor = float(step.get("factor") or 0)
    if not 0.1 <= factor <= 8:
        raise MediaError("speed needs factor between 0.1 (10x slower) and 8 (8x faster); 2 is double speed")
    args = ["-i", cur]
    if info["has_video"]:
        args += ["-filter:v", f"setpts=PTS/{factor}"]
    if info["has_audio"]:
        args += ["-filter:a", atempo_chain(factor)]
    out = job.temp(out_ext(info))
    ffmpeg(args + encode_args(info) + [out], "Changing the speed")
    return out


def step_reframe(cur, info, step, job):
    need_video(info, "reframe")
    aspect = str(step.get("aspect") or "9:16")
    if aspect not in ASPECTS:
        raise MediaError(f"aspect must be one of {', '.join(ASPECTS)}")
    w, h = ASPECTS[aspect]
    fit = step.get("fit") or "crop"
    if fit == "blur":
        # The whole picture, centred over a blurred, zoomed copy of itself.
        graph = (f"[0:v]split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=20:2[bg];"
                 f"[b]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]")
    elif fit == "pad":
        graph = f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v]"
    else:
        # Crop: keep the middle (or the side asked for) and fill the frame.
        pos = str(step.get("position") or "center")
        x = {"left": "0", "right": "iw-ow"}.get(pos, "(iw-ow)/2")
        graph = f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:{x.replace('iw', 'in_w').replace('ow', 'out_w')}:(in_h-out_h)/2,setsar=1[v]"
    out = job.temp(".mp4")
    maps = ["-map", "[v]"] + (["-map", "0:a:0"] if info["has_audio"] else [])
    ffmpeg(["-i", cur, "-filter_complex", graph, *maps, *encode_args(info), out], f"Reframing to {aspect}")
    return out


def mix_with(cur, info, other, job, *, volume, start=0.0, duck=True, loop=False, fade_out=0.0, fade_in=0.0, what="Mixing"):
    """Adds the sound of `other` under (or over) the clip's own sound."""
    args = ["-i", cur]
    args += (["-stream_loop", "-1"] if loop else []) + ["-i", other]
    total = info["duration"]
    m = f"[1:a]aresample=48000,volume={volume:.3f}"
    if fade_in:
        m += f",afade=t=in:st=0:d={fade_in:.2f}"
    if start:
        ms = int(start * 1000)
        m += f",adelay={ms}|{ms}"
    m += f",atrim=0:{total:.3f}"
    if fade_out and total > fade_out:
        m += f",afade=t=out:st={total - fade_out:.3f}:d={fade_out:.2f}"
    m += "[m]"
    if info["has_audio"]:
        if duck:
            # The added sound dips whenever someone talks (sidechain compression).
            graph = (f"{m};[0:a]aresample=48000,asplit=2[main][sc];[m][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=500[md];"
                     "[main][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]")
        else:
            graph = f"{m};[0:a]aresample=48000[main];[main][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]"
    else:
        graph = f"{m};[m]apad=whole_dur={total:.3f}[a]"
    out = job.temp(out_ext(info))
    maps = (["-map", "0:v:0", "-c:v", "copy"] if info["has_video"] else ["-vn"]) + ["-map", "[a]"]
    ffmpeg(args + ["-filter_complex", graph, *maps, *AUDIO_CODEC, "-t", f"{total:.3f}", "-movflags", "+faststart", out], what)
    return out


def level(value, default):
    """0.15, "15%", or decibels like "-18dB" -> a volume multiplier."""
    if value in (None, ""):
        return default
    text = str(value).strip().lower()
    try:
        if text.endswith("db"):
            return 10 ** (float(text[:-2]) / 20)
        if text.endswith("%"):
            return float(text[:-1]) / 100
        v = float(text)
        return v / 100 if v > 4 else v
    except ValueError:
        raise MediaError(f"volume '{value}' isn't a number like 0.15, 15% or -16dB")


def step_add_music(cur, info, step, job):
    music = media_path(step.get("file") or "")
    return mix_with(cur, info, music, job, volume=level(step.get("volume"), 0.15), start=seconds(step.get("start", 0)),
                    duck=step.get("duck", True) is not False, loop=step.get("loop", True) is not False,
                    fade_in=float(step.get("fade_in", 1.0) or 0), fade_out=float(step.get("fade_out", 2.0) or 0), what="Adding music")


def step_voiceover(cur, info, step, job):
    voice = media_path(step.get("file") or "")
    return mix_with(cur, info, voice, job, volume=level(step.get("volume"), 1.0), start=seconds(step.get("start", 0)),
                    duck=False, loop=False, what="Adding the voiceover") if not (step.get("duck", True) and info["has_audio"]) \
        else duck_under(cur, info, voice, job, level(step.get("volume"), 1.0), seconds(step.get("start", 0)))


def duck_under(cur, info, voice, job, volume, start):
    """The voiceover on top, with the clip's own sound dipping while it talks."""
    ms = int(start * 1000)
    total = info["duration"]
    graph = (f"[1:a]aresample=48000,volume={volume:.3f},adelay={ms}|{ms},apad,atrim=0:{total:.3f},asplit=2[vo][sc];"
             "[0:a]aresample=48000[orig];[orig][sc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=600[ducked];"
             "[ducked][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]")
    out = job.temp(out_ext(info))
    maps = (["-map", "0:v:0", "-c:v", "copy"] if info["has_video"] else ["-vn"]) + ["-map", "[a]"]
    ffmpeg(["-i", cur, "-i", voice, "-filter_complex", graph, *maps, *AUDIO_CODEC, "-t", f"{total:.3f}", "-movflags", "+faststart", out], "Adding the voiceover")
    return out


def step_replace_audio(cur, info, step, job):
    need_video(info, "replace_audio")
    sound = media_path(step.get("file") or "")
    out = job.temp(".mp4")
    loop = ["-stream_loop", "-1"] if step.get("loop") else []
    ffmpeg(["-i", cur, *loop, "-i", sound, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *AUDIO_CODEC, "-t", f"{info['duration']:.3f}", "-movflags", "+faststart", out], "Replacing the sound")
    return out


def step_mute(cur, info, step, job):
    need_video(info, "mute")
    out = job.temp(".mp4")
    ffmpeg(["-i", cur, "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", out], "Removing the sound")
    return out


def step_volume(cur, info, step, job):
    need_audio(info, "volume")
    out = job.temp(out_ext(info))
    vcopy = ["-map", "0:v:0", "-c:v", "copy"] if info["has_video"] else ["-vn"]
    ffmpeg(["-i", cur, *vcopy, "-map", "0:a:0", "-filter:a", f"volume={level(step.get('volume', step.get('level')), 1.0):.3f}", *AUDIO_CODEC, out], "Changing the volume")
    return out


def step_normalize(cur, info, step, job):
    need_audio(info, "normalize")
    target = float(step.get("loudness", -14))
    out = job.temp(out_ext(info))
    vcopy = ["-map", "0:v:0", "-c:v", "copy"] if info["has_video"] else ["-vn"]
    ffmpeg(["-i", cur, *vcopy, "-map", "0:a:0", "-filter:a", f"loudnorm=I={target}:TP=-1.5:LRA=11", "-ar", "48000", *AUDIO_CODEC, out], "Evening out the loudness")
    return out


def step_clean_speech(cur, info, step, job):
    need_audio(info, "clean_speech")
    wav, clean = job.temp(".wav"), job.temp(".wav")
    ffmpeg(["-i", cur, "-vn", "-ac", "1", "-ar", "48000", wav], "Extracting the sound")
    limit = step.get("strength")
    # strength 0-100: how many dB of noise to take out at most (default: all of it).
    deepfilter(wav, clean, atten_lim_db=float(limit) if limit not in (None, "") else None)
    job.notes.append("Background noise removed with DeepFilterNet; the speech was kept.")
    return with_new_audio(cur, info, clean, job)


def step_isolate(cur, info, step, job, keep):
    need_audio(info, step.get("op"))
    stems = demucs_split(cur, job)
    wav = stems["vocals" if keep == "voice" else "no_vocals"]
    job.notes.append("Voices kept, music and other sounds removed (Demucs)." if keep == "voice" else "Voices removed, music and other sounds kept (Demucs).")
    return with_new_audio(cur, info, wav, job)


def step_captions(cur, info, step, job):
    need_audio(info, "captions")
    transcript = transcript_of(cur, step.get("language"))
    if not transcript["segments"]:
        job.notes.append("Whisper heard no speech, so there are no captions.")
        return cur
    words = int(step.get("words_per_line", 4) or 0)
    lines = caption_lines(transcript, words)
    srt = job.temp(".srt")
    write_srt(lines, srt)
    job.extras.append(("srt", srt))
    if step.get("burn", True) is False or not info["has_video"]:
        job.notes.append("Captions saved as an .srt file (not burned in).")
        return cur
    h = info["height"] or 1080
    # Subtitle sizes are on a 288-line-tall canvas whatever the video's size: 18 is about 6% of the height.
    size = int(step.get("size") or 16)
    pos = str(step.get("position") or "bottom")
    # force_style takes the old SSA numbers: 6 top, 10 middle, 2 bottom.
    align = {"top": 6, "center": 10, "middle": 10, "bottom": 2}.get(pos, 2)
    margin = 40 if pos == "bottom" and h > info["width"] else 18
    color = ass_color(step.get("color") or "white")
    style = (f"FontName=DejaVu Sans,FontSize={size},Bold=1,PrimaryColour={color},OutlineColour=&H00000000,"
             f"BorderStyle=1,Outline=3,Shadow=0,Alignment={align},MarginV={margin}")
    out = job.temp(".mp4")
    escaped = srt.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    vf = f"subtitles='{escaped}':original_size={info['width']}x{h}:force_style='{style}'"
    ffmpeg(["-i", cur, "-vf", vf, *encode_args(info), out], "Burning in the captions")
    job.notes.append(f"Captions from Whisper ({transcript['language']}) burned in, {words or 'whole sentences'} words at a time.")
    return out


COLORS = {"white": "FFFFFF", "yellow": "FFE600", "black": "000000", "red": "FF3B30", "green": "34C759", "blue": "0A84FF", "pink": "FF2D92", "orange": "FF9500"}


def hex_color(value):
    text = str(value or "white").strip().lower().lstrip("#")
    text = COLORS.get(text, text)
    if not re.fullmatch(r"[0-9a-f]{6}", text, re.I):
        raise MediaError(f"color '{value}' isn't a name like white or yellow or a hex code like #FFE600")
    return text.upper()


def ass_color(value):
    rgb = hex_color(value)
    return f"&H00{rgb[4:6]}{rgb[2:4]}{rgb[0:2]}"


def place(pos, margin="40"):
    pos = pos if pos in POSITIONS else "bottom"
    x = {"left": margin, "right": f"W-w-{margin}"}.get(pos.split("-")[-1] if "-" in pos else "", "(W-w)/2")
    y = "(H-h)/2" if pos == "center" else (margin if pos.startswith("top") else f"H-h-{margin}")
    return x, y


def step_text(cur, info, step, job):
    need_video(info, "text")
    text = str(step.get("text") or "").strip()
    if not text:
        raise MediaError("text needs the words to show")
    textfile = job.temp(".txt")
    with open(textfile, "w", encoding="utf-8") as f:
        f.write(text)
    h = info["height"] or 1080
    size = int(step.get("size") or max(24, h // 18))
    x, y = place(str(step.get("position") or "top"), str(int(h * 0.06)))
    # drawtext names: w/h is the frame, text_w/text_h the text.
    x = x.replace("W-w", "w-text_w").replace("(W-w)", "(w-text_w)")
    y = y.replace("H-h", "h-text_h").replace("(H-h)", "(h-text_h)")
    draw = (f"drawtext=fontfile={FONT}:textfile='{textfile}':expansion=none:fontsize={size}:fontcolor=0x{hex_color(step.get('color'))}:"
            f"x={x}:y={y}:borderw={max(2, size // 14)}:bordercolor=black")
    if step.get("box"):
        draw += ":box=1:boxcolor=black@0.55:boxborderw=18"
    if "start" in step or "end" in step:
        a = seconds(step.get("start", 0))
        b = seconds(step["end"]) if step.get("end") not in (None, "") else info["duration"]
        draw += f":enable='between(t,{a:.3f},{b:.3f})'"
    out = job.temp(".mp4")
    ffmpeg(["-i", cur, "-vf", draw, *encode_args(info), out], "Adding text")
    return out


def step_logo(cur, info, step, job):
    need_video(info, "logo")
    logo = media_path(step.get("file") or "")
    width = max(16, int(info["width"] * float(step.get("scale", 0.15))))
    opacity = max(0.0, min(1.0, float(step.get("opacity", 0.9))))
    x, y = place(str(step.get("position") or "top-right"), str(int(info["width"] * 0.03)))
    graph = f"[1:v]scale={width}:-1,format=rgba,colorchannelmixer=aa={opacity:.2f}[lg];[0:v][lg]overlay={x}:{y}"
    if "start" in step or "end" in step:
        a = seconds(step.get("start", 0))
        b = seconds(step["end"]) if step.get("end") not in (None, "") else info["duration"]
        graph += f":enable='between(t,{a:.3f},{b:.3f})'"
    out = job.temp(".mp4")
    maps = ["-map", "0:a:0?"]
    ffmpeg(["-i", cur, "-loop", "1", "-i", logo, "-filter_complex", graph + "[v]", "-map", "[v]", *maps, "-shortest", *encode_args(info), out], "Adding the logo")
    return out


def step_fade(cur, info, step, job):
    fin, fout = float(step.get("in", 0.5) or 0), float(step.get("out", 1.0) or 0)
    d = info["duration"]
    vf, af = [], []
    if fin:
        vf.append(f"fade=t=in:st=0:d={fin}")
        af.append(f"afade=t=in:st=0:d={fin}")
    if fout and d > fout:
        vf.append(f"fade=t=out:st={d - fout:.3f}:d={fout}")
        af.append(f"afade=t=out:st={d - fout:.3f}:d={fout}")
    args = ["-i", cur]
    if info["has_video"] and vf:
        args += ["-vf", ",".join(vf)]
    if info["has_audio"] and af:
        args += ["-af", ",".join(af)]
    out = job.temp(out_ext(info))
    ffmpeg(args + encode_args(info) + [out], "Fading")
    return out


def step_resize(cur, info, step, job):
    need_video(info, "resize")
    w = int(step.get("width") or -2)
    h = int(step.get("height") or -2)
    if w == -2 and h == -2:
        raise MediaError("resize needs width or height")
    out = job.temp(".mp4")
    ffmpeg(["-i", cur, "-vf", f"scale={w}:{h}", *encode_args(info), out], "Resizing")
    return out


def step_rotate(cur, info, step, job):
    need_video(info, "rotate")
    turn = {"90": "transpose=1", "-90": "transpose=2", "270": "transpose=2", "180": "transpose=1,transpose=1",
            "flip": "hflip", "mirror": "hflip", "upside_down": "vflip"}.get(str(step.get("angle", step.get("direction", "90"))))
    if not turn:
        raise MediaError("rotate takes angle 90, -90 or 180, or direction flip")
    out = job.temp(".mp4")
    ffmpeg(["-i", cur, "-vf", turn, *encode_args(info), out], "Rotating")
    return out


def step_compress(cur, info, step, job):
    need_video(info, "compress")
    crf = {"high": 20, "medium": 25, "small": 30}.get(str(step.get("quality") or "medium"), 25)
    vf = []
    if step.get("max_height") and info["height"] > int(step["max_height"]):
        vf = ["-vf", f"scale=-2:{int(step['max_height'])}"]
    out = job.temp(".mp4")
    ffmpeg(["-i", cur, *vf, "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", *(["-c:a", "aac", "-b:a", "128k"] if info["has_audio"] else ["-an"]), "-movflags", "+faststart", out], "Making the file smaller")
    return out


# Final steps: they change the kind of file, so they come last.

def step_gif(cur, info, step, job):
    need_video(info, "gif")
    a = seconds(step.get("start", 0))
    d = float(step.get("duration") or min(6.0, max(0.5, info["duration"] - a)))
    width = int(step.get("width") or 480)
    fps = int(step.get("fps") or 12)
    out = job.temp(".gif")
    graph = f"fps={fps},scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"
    ffmpeg(["-ss", f"{a:.3f}", "-t", f"{d:.3f}", "-i", cur, "-filter_complex", graph, "-loop", "0", out], "Making the GIF")
    return out


def step_extract_audio(cur, info, step, job):
    need_audio(info, "extract_audio")
    fmt = str(step.get("format") or "mp3").lower()
    codecs = {"mp3": ["-c:a", "libmp3lame", "-q:a", "2"], "wav": ["-c:a", "pcm_s16le"], "m4a": AUDIO_CODEC, "flac": ["-c:a", "flac"]}
    if fmt not in codecs:
        raise MediaError(f"format must be one of {', '.join(codecs)}")
    out = job.temp("." + fmt)
    ffmpeg(["-i", cur, "-vn", *codecs[fmt], out], "Saving the sound")
    return out


def step_thumbnail(cur, info, step, job):
    need_video(info, "thumbnail")
    t = seconds(step.get("time", min(1.0, info["duration"] / 2)))
    out = job.temp(".jpg")
    ffmpeg(["-ss", f"{t:.3f}", "-i", cur, "-frames:v", "1", "-q:v", "2", out], "Saving a still")
    return out


def step_convert(cur, info, step, job):
    fmt = str(step.get("format") or "mp4").lower()
    if fmt in ("mp3", "wav", "m4a", "flac"):
        return step_extract_audio(cur, info, {"format": fmt}, job)
    if fmt == "gif":
        return step_gif(cur, info, step, job)
    if fmt not in ("mp4", "mov", "webm", "mkv"):
        raise MediaError("format must be mp4, mov, webm, mkv, gif, mp3, wav, m4a or flac")
    out = job.temp("." + fmt)
    if fmt == "webm":
        codecs = (["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1"] if info["has_video"] else ["-vn"]) + (["-c:a", "libopus"] if info["has_audio"] else ["-an"])
    else:
        codecs = encode_args(info)
    ffmpeg(["-i", cur, *codecs, out], f"Converting to {fmt}")
    return out


STEPS = {
    "trim": step_trim, "keep": step_keep, "cut": step_cut, "join": step_join, "speed": step_speed,
    "reframe": step_reframe, "add_music": step_add_music, "voiceover": step_voiceover,
    "replace_audio": step_replace_audio, "mute": step_mute, "volume": step_volume, "normalize": step_normalize,
    "clean_speech": step_clean_speech, "keep_voice": lambda c, i, s, j: step_isolate(c, i, s, j, "voice"),
    "remove_voice": lambda c, i, s, j: step_isolate(c, i, s, j, "music"), "captions": step_captions,
    "text": step_text, "logo": step_logo, "fade": step_fade, "resize": step_resize, "rotate": step_rotate,
    "compress": step_compress, "gif": step_gif, "extract_audio": step_extract_audio, "thumbnail": step_thumbnail,
    "convert": step_convert
}
FINAL_STEPS = {"gif", "extract_audio", "thumbnail"}
ALIASES = {"crop_vertical": "reframe", "vertical": "reframe", "denoise": "clean_speech", "remove_noise": "clean_speech",
           "music": "add_music", "subtitles": "captions", "watermark": "logo", "remove_music": "keep_voice",
           "instrumental": "remove_voice", "concat": "join", "loudness": "normalize"}


def edit(spec):
    src = media_path(spec.get("input"))
    steps = spec.get("steps") or []
    if not isinstance(steps, list) or not steps:
        raise MediaError("steps is empty: list what to do, like [{\"op\": \"clean_speech\"}]")
    job = Job()
    try:
        cur = src
        for n, step in enumerate(steps, 1):
            if not isinstance(step, dict):
                raise MediaError(f"step {n} isn't an object like {{\"op\": \"trim\", \"start\": 5}}")
            op = ALIASES.get(str(step.get("op") or "").strip().lower(), str(step.get("op") or "").strip().lower())
            if op not in STEPS:
                raise MediaError(f"step {n}: unknown op '{step.get('op')}'. Known: {', '.join(sorted(STEPS))}")
            if cur != src and os.path.splitext(cur)[1] in (".gif", ".jpg", ".mp3", ".wav", ".flac") and op not in ("convert",):
                raise MediaError(f"step {n} ({op}) comes after a step that made a {os.path.splitext(cur)[1]}; put gif, extract_audio and thumbnail last")
            info = probe(cur)
            say(f"Step {n} of {len(steps)}: {op}")
            try:
                cur = STEPS[op](cur, info, {**step, "op": op}, job)
            except MediaError as err:
                raise MediaError(f"step {n} ({op}): {err}")
        if cur == src:
            raise MediaError("nothing changed")
        base = media_path(spec.get("output") or "outputs/edited", must_exist=False)
        os.makedirs(os.path.dirname(base), exist_ok=True)
        final = unique(base + os.path.splitext(cur)[1])
        shutil.move(cur, final)
        made = [final]
        for kind, path in job.extras:
            extra = unique(os.path.splitext(final)[0] + "." + kind)
            shutil.copyfile(path, extra)
            made.append(extra)
        result = {"ok": True, "output": shown(final), "files": [shown(p) for p in made], "notes": job.notes}
        result["info"] = probe(final) if not final.endswith((".jpg", ".srt")) else {}
        return result
    finally:
        job.close()


def unique(path):
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    i = 2
    while os.path.exists(f"{stem}-{i}{ext}"):
        i += 1
    return f"{stem}-{i}{ext}"


def transcribe(spec):
    src = media_path(spec.get("input"))
    transcript = transcript_of(src, spec.get("language"))
    base = media_path(spec.get("output") or "outputs/" + os.path.splitext(os.path.basename(src))[0] + "-transcript", must_exist=False)
    os.makedirs(os.path.dirname(base), exist_ok=True)
    srt, txt = unique(base + ".srt"), unique(base + ".txt")
    write_srt(caption_lines(transcript, 0), srt)
    with open(txt, "w", encoding="utf-8") as f:
        for seg in transcript["segments"]:
            f.write(f"[{stamp(seg['start'])[:8]}] {seg['text']}\n")
    lines = [f"[{stamp(s['start'])[3:11]}-{stamp(s['end'])[3:11]}] {s['text']}" for s in transcript["segments"]]
    return {"ok": True, "language": transcript["language"], "files": [shown(srt), shown(txt)], "transcript": "\n".join(lines)}


def find(spec):
    src = media_path(spec.get("input"))
    query = str(spec.get("query") or "").strip().lower()
    if not query:
        raise MediaError("find needs query: the words to look for")
    transcript = transcript_of(src, spec.get("language"))
    terms = [t for t in re.findall(r"[\w']+", query) if len(t) > 2] or [query]
    hits = []
    for seg in transcript["segments"]:
        text = seg["text"].lower()
        score = 3 if query in text else sum(1 for t in terms if t in text) / len(terms)
        if score >= 0.5:
            hits.append({"start": seg["start"], "end": seg["end"], "text": seg["text"], "score": round(score, 2)})
    hits.sort(key=lambda h: (-h["score"], h["start"]))
    return {"ok": True, "query": query, "matches": hits[:20], "segments": len(transcript["segments"])}


def separate(spec):
    src = media_path(spec.get("input"))
    job = Job()
    try:
        stems = demucs_split(src, job, two_stems=str(spec.get("stems") or "vocals") != "all")
        base = media_path(spec.get("output") or "outputs/" + os.path.splitext(os.path.basename(src))[0], must_exist=False)
        os.makedirs(os.path.dirname(base), exist_ok=True)
        names = {"vocals": "voice", "no_vocals": "music-and-sounds", "drums": "drums", "bass": "bass", "other": "other"}
        made = []
        for stem, wav in sorted(stems.items()):
            out = unique(f"{base}-{names.get(stem, stem)}.mp3")
            ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-q:a", "2", out], f"Saving {stem}")
            made.append(shown(out))
        return {"ok": True, "files": made}
    finally:
        job.close()


def download_models():
    from faster_whisper import WhisperModel
    WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=WHISPER_DIR)
    from demucs.pretrained import get_model
    get_model("htdemucs")
    from df.enhance import init_df
    init_df(log_level="ERROR")
    return {"ok": True}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    try:
        if cmd == "download-models":
            result = download_models()
        elif cmd == "info":
            result = {"ok": True, "file": argv[2], **probe(media_path(argv[2]))}
        elif cmd in ("edit", "transcribe", "find", "separate"):
            with open(media_path(argv[2]), encoding="utf-8") as f:
                spec = json.load(f)
            result = {"edit": edit, "transcribe": transcribe, "find": find, "separate": separate}[cmd](spec)
        else:
            raise MediaError(f"unknown command {cmd}")
    except MediaError as err:
        result = {"ok": False, "error": str(err)}
    except Exception as err:  # a tool crashed: still answer in JSON
        result = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
