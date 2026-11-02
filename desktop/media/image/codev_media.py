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


# Whisper leaves out "um" and "uh" unless the prompt shows it some.
FILLER_PROMPT = "Umm, let me think like, hmm... Okay, uh, here's what I'm, like, thinking. Er, so, um."


def transcript_of(path, language=None, fillers=False, translate=False):
    """Segments with word times, cached per file so captions and finds reuse it.
    fillers: keep "um", "uh" and friends (for cutting them). translate: English words for any language."""
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}|{language or ''}|{WHISPER_MODEL}|{fillers}|{translate}".encode()).hexdigest()[:16]
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
        segments, info = whisper_model().transcribe(wav, language=language or None, word_timestamps=True, vad_filter=not fillers,
                                                    task="translate" if translate else "transcribe",
                                                    initial_prompt=FILLER_PROMPT if fillers else None)
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
    if step.get("transition") and step.get("transition") != "none":
        return crossfade_join(parts, job, str(step["transition"]), float(step.get("duration", 0.5) or 0.5))
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
    if step.get("text") and not step.get("file"):
        return step_voiceover_text(cur, info, step, job)
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
    transcript = transcript_of(cur, step.get("language"), translate=bool(step.get("translate")))
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
    if str(step.get("style") or "") in ("highlight", "karaoke", "word"):
        return burn_highlight_captions(cur, info, step, transcript, max(1, words or 4), job)
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
    a = seconds(step.get("start", 0)) if "start" in step else 0.0
    b = seconds(step["end"]) if step.get("end") not in (None, "") else info["duration"]
    if "start" in step or "end" in step:
        draw += f":enable='between(t,{a:.3f},{b:.3f})'"
    anim = str(step.get("animation") or "none")
    if anim == "typewriter":
        vf = typewriter(draw, text, textfile, a, b, job)
    else:
        vf = animate_text(draw, anim, x, y, a, b)
    out = job.temp(".mp4")
    ffmpeg(["-i", cur, "-vf", vf, *encode_args(info), out], "Adding text")
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


# ---------- round 2: smarter cuts, motion, looks ----------

FILLERS = {"um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mmm", "eh"}


def merge_ranges(ranges, gap=0.0):
    out = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1] + gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def keep_all_but(cur, info, cuts, job):
    keep, at = [], 0.0
    for a, b in merge_ranges(cuts):
        if a > at:
            keep.append((at, a))
        at = max(at, b)
    if at < info["duration"]:
        keep.append((at, info["duration"]))
    return keep_ranges(cur, info, [r for r in keep if r[1] - r[0] > 0.05], job)


def step_remove_silence(cur, info, step, job):
    """Cuts the pauses: every quiet stretch longer than min_silence, leaving padding on each side."""
    need_audio(info, "remove_silence")
    min_len = float(step.get("min_silence", 0.6) or 0.6)
    floor = float(step.get("threshold_db", -35) or -35)
    pad = float(step.get("padding", 0.15) or 0)
    # silencedetect reports on stderr.
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", cur, "-map", "0:a:0", "-af", f"silencedetect=noise={floor}dB:d={min_len}", "-f", "null", "-"],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stderr
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", out)]
    cuts = []
    for i, a in enumerate(starts):
        b = ends[i] if i < len(ends) else info["duration"]
        a, b = max(0.0, a) + pad, b - pad
        if b - a > 0.1:
            cuts.append((a, b))
    if not cuts:
        job.notes.append("No pauses long enough to cut.")
        return cur
    removed = sum(b - a for a, b in cuts)
    job.notes.append(f"Cut {len(cuts)} pauses ({removed:.1f}s in all).")
    return keep_all_but(cur, info, cuts, job)


def step_remove_fillers(cur, info, step, job):
    """Cuts "um", "uh" and the like, found word by word by Whisper."""
    need_audio(info, "remove_fillers")
    extra = {w.lower().strip(" ,.!?") for w in (step.get("words") or [])}
    targets = FILLERS | extra
    transcript = transcript_of(cur, step.get("language"), fillers=True)
    cuts = []
    for seg in transcript["segments"]:
        words = seg.get("words") or []
        for i, w in enumerate(words):
            token = re.sub(r"[^\w' ]", "", w["word"].lower()).strip()
            phrase2 = token + " " + re.sub(r"[^\w' ]", "", words[i + 1]["word"].lower()).strip() if i + 1 < len(words) else ""
            if token in targets:
                cuts.append((max(0.0, w["start"] - 0.03), w["end"] + 0.03))
            elif phrase2 in targets:
                cuts.append((max(0.0, w["start"] - 0.03), words[i + 1]["end"] + 0.03))
    if not cuts:
        job.notes.append("Whisper heard no filler words to cut.")
        return cur
    job.notes.append(f"Cut {len(cuts)} filler words (um, uh...).")
    return keep_all_but(cur, info, cuts, job)


def speed_pieces(info, ranges, smooth):
    """The clip as (start, end, factor) pieces covering all of it."""
    pieces, at = [], 0.0
    for a, b, f in sorted(ranges):
        if a > at:
            pieces.append((at, a, 1.0))
        pieces.append((max(a, at), b, f))
        at = b
    if at < info["duration"] - 0.02:
        pieces.append((at, info["duration"], 1.0))
    return [p for p in pieces if p[1] - p[0] > 0.02]


def retime(cur, info, pieces, job, smooth=False, what="Changing the speed"):
    parts, labels = [], ""
    fps = info.get("fps") or 30
    for i, (a, b, f) in enumerate(pieces):
        if info["has_video"]:
            v = f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{f:.4f}"
            if smooth and f < 1:
                # Motion-compensated in-between frames, so slow motion doesn't stutter.
                v += f",minterpolate=fps={fps:g}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"
            parts.append(v + f",fps={fps:g}[v{i}]")
            labels += f"[v{i}]"
        if info["has_audio"]:
            parts.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,{atempo_chain(f)}[a{i}]")
            labels += f"[a{i}]"
    v, a = int(info["has_video"]), int(info["has_audio"])
    graph = ";".join(parts) + f";{labels}concat=n={len(pieces)}:v={v}:a={a}" + ("[v]" if v else "") + ("[a]" if a else "")
    out = job.temp(out_ext(info))
    maps = (["-map", "[v]"] if v else []) + (["-map", "[a]"] if a else [])
    ffmpeg(["-i", cur, "-filter_complex", graph, *maps, *encode_args(info), out], what)
    return out


def step_speed_ramp(cur, info, step, job):
    """Different speeds for different parts: [{start, end, factor}, ...]; the rest stays at normal speed."""
    ranges = []
    for r in step.get("ranges") or []:
        f = float(r.get("factor") or 0)
        if not 0.1 <= f <= 8:
            raise MediaError("each range needs factor between 0.1 and 8")
        a = seconds(r.get("start", 0))
        b = seconds(r["end"]) if r.get("end") not in (None, "") else info["duration"]
        ranges.append((max(0.0, a), min(info["duration"], b), f))
    if not ranges:
        raise MediaError("speed_ramp needs ranges: [{start, end, factor}, ...]")
    return retime(cur, info, speed_pieces(info, ranges, False), job, smooth=step.get("smooth", True) is not False)


def step_slow_motion(cur, info, step, job):
    """Smooth slow motion (FFmpeg's motion interpolation) for the whole clip or one part."""
    need_video(info, "slow_motion")
    f = float(step.get("factor", 0.5) or 0.5)
    if not 0.1 <= f < 1:
        raise MediaError("slow_motion needs factor below 1, like 0.5 (half speed) or 0.25")
    a = seconds(step.get("start", 0)) if "start" in step else 0.0
    b = seconds(step["end"]) if step.get("end") not in (None, "") else info["duration"]
    job.notes.append("Slow motion with motion-smoothed in-between frames.")
    return retime(cur, info, speed_pieces(info, [(a, b, f)], True), job, smooth=step.get("smooth", True) is not False, what="Making the slow motion")


TRANSITIONS = {"fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright",
               "slideup", "slidedown", "circleopen", "circleclose", "radial", "pixelize", "zoomin", "smoothleft", "smoothright", "hblur", "distance"}


def crossfade_join(parts, job, kind, d):
    """Joins the prepared clips with an xfade transition between each."""
    if kind not in TRANSITIONS:
        raise MediaError(f"transition must be one of {', '.join(sorted(TRANSITIONS))}")
    lengths = [probe(p)["duration"] for p in parts]
    d = max(0.1, min(d, min(lengths) / 2 - 0.05))
    args, graph, v, a, offset = [], [], "[0:v]", "[0:a]", 0.0
    for p in parts:
        args += ["-i", p]
    for i in range(1, len(parts)):
        offset += lengths[i - 1] - d
        graph.append(f"{v}[{i}:v]xfade=transition={kind}:duration={d:.3f}:offset={offset:.3f}[v{i}]")
        graph.append(f"{a}[{i}:a]acrossfade=d={d:.3f}[a{i}]")
        v, a = f"[v{i}]", f"[a{i}]"
    out = job.temp(".mp4")
    ffmpeg(args + ["-filter_complex", ";".join(graph), "-map", v, "-map", a, *VIDEO_CODEC, *AUDIO_CODEC, "-movflags", "+faststart", out], f"Joining with {kind} transitions")
    return out


def animate_text(draw, anim, x, y, a, b):
    """drawtext with a fade, slide or pop in (and out)."""
    t = f"(t-{a:.3f})"
    if anim == "fade":
        return draw + f":alpha='if(lt(t,{a + 0.4:.3f}),{t}/0.4,if(gt(t,{b - 0.4:.3f}),({b:.3f}-t)/0.4,1))'"
    if anim in ("slide_up", "slide"):
        return draw.replace(f":y={y}:", f":y='{y}+h*0.12*max(0,1-{t}/0.35)':") + f":alpha='min(1,{t}/0.35)'"
    if anim == "slide_left":
        return draw.replace(f":x={x}:", f":x='{x}+w*max(0,1-{t}/0.4)':")
    if anim == "pop":
        size = re.search(r":fontsize=(\d+)", draw).group(1)
        return draw.replace(f":fontsize={size}", f":fontsize='{size}*min(1,0.4+{t}/0.25)'")
    if anim not in ("none", ""):
        raise MediaError("animation must be fade, slide_up, slide_left, pop or typewriter")
    return draw


def typewriter(draw, text, textfile, a, b, job):
    """One drawtext per letter count, each shown in turn, so the text types itself."""
    if len(text) > 80:
        raise MediaError("typewriter text is limited to 80 characters")
    step_t = min(0.08, max(0.02, (b - a) * 0.5 / max(1, len(text))))
    filters = []
    for n in range(1, len(text) + 1):
        partial = job.temp(".txt")
        with open(partial, "w", encoding="utf-8") as f:
            f.write(text[:n])
        start = a + (n - 1) * step_t
        end = a + n * step_t if n < len(text) else b
        piece = re.sub(r":enable='[^']*'", "", draw).replace(f"textfile='{textfile}'", f"textfile='{partial}'")
        filters.append(piece + f":enable='between(t,{start:.3f},{end:.3f})'")
    return ",".join(filters)


def burn_highlight_captions(cur, info, step, transcript, words, job):
    """Word-by-word captions: each word lights up as it's said (ASS karaoke)."""
    w, h = info["width"], info["height"]
    size = int(step.get("size") or max(24, int(h * 0.055)))
    pos = str(step.get("position") or "bottom")
    align = {"top": 8, "center": 5, "middle": 5}.get(pos, 2)
    margin = int(h * (0.18 if pos == "bottom" and h > w else 0.07))
    lit, base = ass_color(step.get("color") or "yellow"), ass_color(step.get("base_color") or "white")
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,DejaVu Sans,{size},{lit},{base},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,{max(2, size // 12)},0,{align},40,40,{margin},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    ]
    count = 0
    for seg in transcript["segments"]:
        ws = seg.get("words") or []
        for i in range(0, len(ws), words):
            chunk = ws[i:i + words]
            text = ""
            for j, word in enumerate(chunk):
                nxt = chunk[j + 1]["start"] if j + 1 < len(chunk) else word["end"]
                cs = max(1, int(round((nxt - word["start"]) * 100)))
                clean = word["word"].replace("{", "(").replace("}", ")").replace("\\", "/")
                text += f"{{\\kf{cs}}}{clean} "
            lines.append(f"Dialogue: 0,{stamp(chunk[0]['start'])[1:-1]},{stamp(chunk[-1]['end'] + 0.15)[1:-1]},Default,,0,0,0,,{text.strip()}")
            count += 1
    ass = job.temp(".ass")
    with open(ass, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    out = job.temp(".mp4")
    escaped = ass.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    ffmpeg(["-i", cur, "-vf", f"ass='{escaped}'", *encode_args(info), out], "Burning in the word-by-word captions")
    job.notes.append(f"Word-by-word captions from Whisper ({transcript['language']}): each word lights up as it's said.")
    return out


LOOKS = {
    "warm": "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.06:bm=-0.06,eq=saturation=1.1",
    "cool": "colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.06,eq=saturation=1.05",
    "vibrant": "eq=saturation=1.45:contrast=1.08",
    "cinematic": "curves=preset=medium_contrast,colorbalance=rs=-0.05:bs=0.06:rh=0.06:bh=-0.04,eq=saturation=0.9",
    "vintage": "curves=preset=vintage,eq=saturation=0.85",
    "sepia": "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
    "bw": "hue=s=0,eq=contrast=1.1",
    "faded": "curves=all='0/0.08 1/0.92',eq=saturation=0.8",
    "bright": "eq=brightness=0.06:contrast=1.05:gamma=1.05",
    "moody": "eq=brightness=-0.04:contrast=1.15:saturation=0.8,colorbalance=bs=0.05:bm=0.03"
}


def step_look(cur, info, step, job):
    """A color look (warm, cinematic, black and white...) and/or brightness, contrast, saturation."""
    need_video(info, "look")
    chain = []
    preset = str(step.get("preset") or "").lower().replace(" ", "")
    if preset:
        if preset not in LOOKS:
            raise MediaError(f"preset must be one of {', '.join(LOOKS)}")
        chain.append(LOOKS[preset])
    eq = []
    for key, lo, hi in (("brightness", -1, 1), ("contrast", 0, 3), ("saturation", 0, 3), ("gamma", 0.1, 3)):
        if step.get(key) not in (None, ""):
            eq.append(f"{key}={max(lo, min(hi, float(step[key])))}")
    if eq:
        chain.append("eq=" + ":".join(eq))
    if step.get("vignette"):
        chain.append("vignette=PI/5")
    if not chain:
        raise MediaError("look needs a preset or brightness, contrast, saturation or gamma")
    out = job.temp(".mp4")
    vf = ",".join(chain)
    strength = float(step.get("strength", 1) or 1)
    if strength < 1:
        # Blend the look with the original.
        graph = f"[0:v]split[o][l];[l]{vf}[g];[o][g]blend=all_mode=normal:all_opacity={strength:.2f},format=yuv420p[v]"
        ffmpeg(["-i", cur, "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", *encode_args(info), out], "Coloring")
    else:
        ffmpeg(["-i", cur, "-vf", vf + ",format=yuv420p", *encode_args(info), out], "Coloring")
    return out


def beat_times(path):
    import librosa
    say("[librosa] finding the beat")
    y, sr = librosa.load(path, sr=22050, mono=True)
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
    times = librosa.frames_to_time(frames, sr=sr).tolist()
    return float(tempo if not hasattr(tempo, "__len__") else tempo[0]), times


def step_montage(cur, info, step, job):
    """Clips and pictures cut to the beat of a song: each piece lasts beats_per_cut beats."""
    music = media_path(step.get("music") or step.get("file") or "")
    sources = [cur] + [media_path(f) for f in (step.get("files") or [])]
    aspect = str(step.get("aspect") or "")
    w, h = ASPECTS.get(aspect, (info.get("width") or 1080, info.get("height") or 1920))
    w, h = w - w % 2, h - h % 2
    tempo, beats = beat_times(music)
    if len(beats) < 4:
        raise MediaError("couldn't find a beat in the music; try another song")
    every = max(1, int(step.get("beats_per_cut", 2) or 2))
    marks = beats[::every]
    total = float(step.get("duration") or 0) or None
    cuts = [(marks[i], marks[i + 1]) for i in range(len(marks) - 1)]
    if total:
        cuts = [c for c in cuts if c[0] < total]
    infos = [probe(p) for p in sources]
    used = [0.0] * len(sources)
    pieces = []
    for n, (a, b) in enumerate(cuts):
        k = n % len(sources)
        length = b - a
        src, si = sources[k], infos[k]
        piece = job.temp(".mp4")
        fit = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps=30,format=yuv420p")
        if si["has_video"] and si["duration"] > 0.3 and os.path.splitext(src)[1].lower() not in IMAGE_EXTS:
            start = used[k] if used[k] + length <= si["duration"] else 0.0
            used[k] = start + length
            ffmpeg(["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", src, "-an", "-vf", fit, *VIDEO_CODEC, piece], f"Cutting piece {n + 1}")
        else:
            # A picture: a slow zoom so it doesn't sit still.
            frames = max(2, int(length * 30))
            zoom = f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase,crop={w * 2}:{h * 2},zoompan=z='min(zoom+0.0015,1.15)':d={frames}:s={w}x{h}:fps=30,setsar=1,format=yuv420p"
            ffmpeg(["-loop", "1", "-t", f"{length:.3f}", "-i", src, "-vf", zoom, "-frames:v", str(frames), *VIDEO_CODEC, piece], f"Animating picture {n + 1}")
        pieces.append(piece)
    if not pieces:
        raise MediaError("the music is too short for a montage")
    listing = job.temp(".txt")
    with open(listing, "w") as f:
        f.writelines(f"file '{p}'\n" for p in pieces)
    silent = job.temp(".mp4")
    ffmpeg(["-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", silent], "Joining the pieces")
    out = job.temp(".mp4")
    length = cuts[len(pieces) - 1][1] - cuts[0][0]
    ffmpeg(["-i", silent, "-ss", f"{cuts[0][0]:.3f}", "-i", music, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *AUDIO_CODEC,
            "-af", f"afade=t=out:st={max(0, length - 1.5):.3f}:d=1.5", "-t", f"{length:.3f}", "-movflags", "+faststart", out], "Adding the music")
    job.notes.append(f"Montage of {len(pieces)} cuts on the beat ({tempo:.0f} BPM, a cut every {every} beats).")
    return out


# ---------- round 2: voices, backgrounds, upscaling ----------

MODELS = os.environ.get("CODEV_MODELS_DIR", "/opt/models")
PIPER_VOICES = {"lessac": "en_US-lessac-medium", "ryan": "en_US-ryan-medium", "amy": "en_US-amy-medium", "alan": "en_GB-alan-medium"}
KOKORO_VOICES = ["af", "af_bella", "af_nicole", "af_sarah", "af_sky", "am_adam", "am_michael", "bf_emma", "bf_isabella", "bm_george", "bm_lewis"]


def speak_to_wav(text, wav, engine="kokoro", voice=None, speed=1.0):
    """Text to speech, on the CPU, offline. Kokoro sounds most natural; Piper is quicker."""
    text = str(text or "").strip()
    if not text:
        raise MediaError("there's no text to say")
    if len(text) > 5000:
        raise MediaError("keep a voiceover under 5000 characters")
    speed = max(0.5, min(2.0, float(speed or 1.0)))
    if engine == "piper":
        import wave
        from piper import PiperVoice, SynthesisConfig
        name = PIPER_VOICES.get(str(voice or "lessac"), str(voice or ""))
        model = os.path.join(MODELS, "piper", f"{name}.onnx")
        if not os.path.isfile(model):
            raise MediaError(f"Piper voices: {', '.join(PIPER_VOICES)}")
        say(f"[Piper] speaking with {name}")
        v = PiperVoice.load(model)
        with wave.open(wav, "wb") as f:
            v.synthesize_wav(text, f, syn_config=SynthesisConfig(length_scale=1.0 / speed))
        return
    import soundfile as sf
    from kokoro_onnx import Kokoro
    voice = str(voice or "af_sarah")
    if voice not in KOKORO_VOICES:
        raise MediaError(f"Kokoro voices: {', '.join(KOKORO_VOICES)} (a = American, b = British, f = female, m = male)")
    say(f"[Kokoro] speaking with {voice}")
    k = Kokoro(os.path.join(MODELS, "kokoro", "kokoro-v0_19.onnx"), os.path.join(MODELS, "kokoro", "voices.json"))
    lang = "en-gb" if voice.startswith("b") else "en-us"
    audio, rate = k.create(text, voice=voice, speed=speed, lang=lang)
    sf.write(wav, audio, rate)


def frames_through(cur, info, job, fn, out_w, out_h, what, fps=None):
    """Runs every frame through fn (an RGB uint8 array in, one out) and keeps the sound."""
    import numpy as np
    w, h = info["width"], info["height"]
    fps = fps or info.get("fps") or 30
    out = job.temp(".mp4")
    dec = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", cur, "-f", "rawvideo", "-pix_fmt", "rgb24", "-vf", f"scale={w}:{h}", "-"],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}", "-r", f"{fps:g}",
                            "-i", "-", "-i", cur, "-map", "0:v:0", "-map", "1:a:0?", *VIDEO_CODEC, *AUDIO_CODEC, "-shortest", "-movflags", "+faststart", out],
                           stdin=subprocess.PIPE)
    size = w * h * 3
    n = 0
    total = max(1, int(info["duration"] * fps))
    try:
        while True:
            buf = dec.stdout.read(size)
            if len(buf) < size:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
            enc.stdin.write(np.ascontiguousarray(fn(frame)).astype(np.uint8).tobytes())
            n += 1
            if n % 50 == 0:
                say(f"[{what}] frame {n} of about {total}")
    finally:
        enc.stdin.close()
        dec.stdout.close()
        dec.wait()
        enc.wait()
    if enc.returncode != 0 or n == 0:
        raise MediaError(f"{what} failed")
    return out


def matting_model():
    import torch
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 4)))
    return torch.jit.load(os.path.join(MODELS, "rvm", "rvm_mobilenetv3_fp32.torchscript"), map_location="cpu").eval()


def background_fill(step, w, h):
    """The new background as an RGB float array (or "blur", worked out per frame)."""
    import numpy as np
    replace = str(step.get("replace") or ("image" if step.get("file") else "color"))
    if replace == "blur":
        return "blur"
    if replace == "image":
        from PIL import Image
        img = Image.open(media_path(step.get("file") or "")).convert("RGB")
        scale = max(w / img.width, h / img.height)
        img = img.resize((max(w, int(img.width * scale + 1)), max(h, int(img.height * scale + 1))))
        left, top = (img.width - w) // 2, (img.height - h) // 2
        return np.asarray(img.crop((left, top, left + w, top + h)), dtype=np.float32)
    color = step.get("color") or "green"
    rgb = "00B140" if str(color).lower() == "green" else hex_color(color)
    color = np.array([int(rgb[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)
    return np.broadcast_to(color, (h, w, 3))


def step_remove_background(cur, info, step, job):
    """Takes the person out of the background (RobustVideoMatting; rembg for a picture) and puts them on a color, a blur or a picture."""
    need_video(info, "remove_background")
    if os.path.splitext(cur)[1].lower() in IMAGE_EXTS or info["duration"] < 0.2:
        return cutout_image(cur, step, job)
    if info["duration"] > 300:
        raise MediaError("background removal is limited to 5 minutes of video at a time; trim it first")
    import numpy as np
    import torch
    model = matting_model()
    w, h = info["width"] - info["width"] % 2, info["height"] - info["height"] % 2
    fill = background_fill(step, w, h)
    rec = [None] * 4
    ratio = min(1.0, 512 / max(w, h))

    def one(frame):
        nonlocal rec
        src = torch.from_numpy(frame[:h, :w].astype(np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
        with torch.no_grad():
            fgr, pha, *rec = model(src, *rec, ratio)
        alpha = pha[0, 0].numpy()[..., None]
        fg = frame[:h, :w].astype(np.float32)
        if isinstance(fill, str):
            import cv2
            bg = cv2.GaussianBlur(fg, (0, 0), 25)
        else:
            bg = fill
        return fg * alpha + bg * (1 - alpha)

    sized = dict(info, width=w, height=h)
    job.notes.append("Background replaced (RobustVideoMatting).")
    return frames_through(cur, sized, job, one, w, h, "Removing the background")


def cutout_image(cur, step, job):
    from PIL import Image
    from rembg import new_session, remove
    say("[rembg] cutting out the subject")
    img = Image.open(cur).convert("RGBA")
    cut = remove(img, session=new_session("isnet-general-use"))
    replace = str(step.get("replace") or "transparent")
    out = job.temp(".png")
    if replace == "transparent" and not step.get("file") and not step.get("color"):
        cut.save(out)
    else:
        import numpy as np
        fill = background_fill(step, cut.width, cut.height)
        if isinstance(fill, str):
            from PIL import ImageFilter
            bg = img.convert("RGB").filter(ImageFilter.GaussianBlur(25))
        else:
            bg = Image.fromarray(np.uint8(fill))
        bg = bg.convert("RGBA")
        bg.alpha_composite(cut)
        bg.convert("RGB").save(out)
    job.notes.append("Background removed (rembg).")
    return out


_upscaler = None


def upscaler():
    """Real-ESRGAN's small general model (realesr-general-x4v3), defined here so no extra package is needed."""
    global _upscaler
    if _upscaler is None:
        import torch
        from torch import nn
        torch.set_num_threads(max(1, min(8, os.cpu_count() or 4)))

        class SRVGGNetCompact(nn.Module):
            def __init__(self, feats=64, convs=32, scale=4):
                super().__init__()
                self.scale = scale
                body = [nn.Conv2d(3, feats, 3, 1, 1), nn.PReLU(num_parameters=feats)]
                for _ in range(convs):
                    body += [nn.Conv2d(feats, feats, 3, 1, 1), nn.PReLU(num_parameters=feats)]
                body.append(nn.Conv2d(feats, 3 * scale * scale, 3, 1, 1))
                self.body = nn.ModuleList(body)
                self.upsampler = nn.PixelShuffle(scale)

            def forward(self, x):
                out = x
                for layer in self.body:
                    out = layer(out)
                return self.upsampler(out) + nn.functional.interpolate(x, scale_factor=self.scale, mode="nearest")

        net = SRVGGNetCompact()
        state = torch.load(os.path.join(MODELS, "esrgan", "realesr-general-x4v3.pth"), map_location="cpu")
        net.load_state_dict(state.get("params", state), strict=True)
        _upscaler = net.eval()
    return _upscaler


def upscale_array(frame, scale):
    import numpy as np
    import torch
    net = upscaler()
    x = torch.from_numpy(frame.astype(np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
    h, w = frame.shape[:2]
    tile = 256
    out = torch.zeros(1, 3, h * 4, w * 4)
    with torch.no_grad():
        for top in range(0, h, tile):
            for left in range(0, w, tile):
                t0, l0 = max(0, top - 8), max(0, left - 8)
                t1, l1 = min(h, top + tile + 8), min(w, left + tile + 8)
                y = net(x[:, :, t0:t1, l0:l1]).clamp(0, 1)
                ot, ol = (top - t0) * 4, (left - l0) * 4
                th, tw = min(tile, h - top) * 4, min(tile, w - left) * 4
                out[:, :, top * 4:top * 4 + th, left * 4:left * 4 + tw] = y[:, :, ot:ot + th, ol:ol + tw]
    if scale != 4:
        out = torch.nn.functional.interpolate(out, size=(int(h * scale), int(w * scale)), mode="area")
    return (out[0].permute(1, 2, 0).numpy() * 255.0).round()


def step_upscale(cur, info, step, job):
    """Sharper, bigger pictures and video with Real-ESRGAN. Slow on a CPU: best for pictures and short clips."""
    need_video(info, "upscale")
    scale = float(step.get("scale", 2) or 2)
    if scale not in (2, 3, 4):
        raise MediaError("scale must be 2, 3 or 4")
    if os.path.splitext(cur)[1].lower() in IMAGE_EXTS or info["duration"] < 0.2:
        from PIL import Image
        import numpy as np
        img = np.asarray(Image.open(cur).convert("RGB"))
        if img.shape[0] * img.shape[1] > 2000 * 2000:
            raise MediaError("the picture is already large; upscale works on pictures up to about 4 megapixels")
        out = job.temp(".png")
        Image.fromarray(np.uint8(upscale_array(img, scale))).save(out)
        job.notes.append(f"Upscaled {scale:g}x with Real-ESRGAN.")
        return out
    w, h = info["width"] - info["width"] % 2, info["height"] - info["height"] % 2
    if h * scale > 2160 or w * scale > 3840:
        raise MediaError(f"{w}x{h} upscaled {scale:g}x would be bigger than 4K; use a smaller scale")
    frames = info["duration"] * (info.get("fps") or 30)
    if frames > 3600:
        raise MediaError("video upscaling is limited to about 2 minutes on a CPU; trim the clip first")
    ow, oh = int(w * scale) - int(w * scale) % 2, int(h * scale) - int(h * scale) % 2
    job.notes.append(f"Upscaled {scale:g}x with Real-ESRGAN, frame by frame.")
    return frames_through(cur, dict(info, width=w, height=h), job, lambda f: upscale_array(f, scale)[:oh, :ow], ow, oh, "Upscaling")


def step_voiceover_text(cur, info, step, job):
    """A voiceover read from text (Kokoro or Piper), mixed like a recorded one."""
    wav = job.temp(".wav")
    speak_to_wav(step.get("text"), wav, engine=str(step.get("engine") or "kokoro"), voice=step.get("voice"), speed=step.get("speed", 1.0))
    if info["has_audio"] and step.get("duck", True):
        return duck_under(cur, info, wav, job, level(step.get("volume"), 1.0), seconds(step.get("start", 0)))
    return mix_with(cur, info, wav, job, volume=level(step.get("volume"), 1.0), start=seconds(step.get("start", 0)), duck=False, loop=False, what="Adding the voiceover")


def highlights(spec):
    """Candidate highlight moments: sentences with loud or lively sound, ranked, for the agent to choose from."""
    src = media_path(spec.get("input"))
    info = probe(src)
    need_audio(info, "highlights")
    transcript = transcript_of(src, spec.get("language"))
    # Loudness per second (EBU R128 momentary), to find the excited parts.
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", src, "-map", "0:a:0", "-af", "ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=-",
                           "-f", "null", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    loud = {}
    t = 0.0
    for line in proc.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"lavfi.r128.M=(-?[\d.]+)", line)
        if m and float(m.group(1)) > -70:
            loud.setdefault(int(t), []).append(float(m.group(1)))
    per_sec = {k: sum(v) / len(v) for k, v in loud.items()}
    mean = sum(per_sec.values()) / len(per_sec) if per_sec else -30
    target = float(spec.get("length", 30) or 30)
    segs = transcript["segments"]
    windows = []
    for i in range(len(segs)):
        j, end = i, segs[i]["end"]
        while j + 1 < len(segs) and segs[j + 1]["end"] - segs[i]["start"] <= target:
            j += 1
            end = segs[j]["end"]
        a = segs[i]["start"]
        secs = [per_sec.get(s, mean) for s in range(int(a), int(end) + 1)]
        energy = (max(secs) - mean) if secs else 0
        text = " ".join(s["text"] for s in segs[i:j + 1])
        words = len(text.split()) / max(1.0, end - a)
        score = energy * 0.6 + words * 1.5 + text.count("!") * 2 + text.count("?") * 0.5
        windows.append({"start": round(max(0, a - 0.3), 2), "end": round(min(info["duration"], end + 0.3), 2), "score": round(score, 2), "text": text[:400]})
    windows.sort(key=lambda w: -w["score"])
    picked = []
    for w in windows:
        if all(w["end"] <= p["start"] or w["start"] >= p["end"] for p in picked):
            picked.append(w)
        if len(picked) >= int(spec.get("count", 5) or 5):
            break
    if not segs:
        # No speech: the loudest stretches.
        ranked = sorted(per_sec.items(), key=lambda kv: -kv[1])[:int(spec.get("count", 5) or 5)]
        picked = [{"start": max(0, k - target / 2), "end": min(info["duration"], k + target / 2), "score": round(v - mean, 2), "text": "(no speech)"} for k, v in ranked]
    return {"ok": True, "duration": info["duration"], "highlights": sorted(picked, key=lambda w: w["start"])}


def speak(spec):
    base = media_path(spec.get("output") or "outputs/voiceover", must_exist=False)
    os.makedirs(os.path.dirname(base), exist_ok=True)
    job = Job()
    try:
        wav = job.temp(".wav")
        speak_to_wav(spec.get("text"), wav, engine=str(spec.get("engine") or "kokoro"), voice=spec.get("voice"), speed=spec.get("speed", 1.0))
        out = unique(base + ".mp3")
        ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-q:a", "2", out], "Saving the voice")
        return {"ok": True, "files": [shown(out)], "info": probe(out)}
    finally:
        job.close()


STEPS = {
    "trim": step_trim, "keep": step_keep, "cut": step_cut, "join": step_join, "speed": step_speed,
    "reframe": step_reframe, "add_music": step_add_music, "voiceover": step_voiceover,
    "replace_audio": step_replace_audio, "mute": step_mute, "volume": step_volume, "normalize": step_normalize,
    "clean_speech": step_clean_speech, "keep_voice": lambda c, i, s, j: step_isolate(c, i, s, j, "voice"),
    "remove_voice": lambda c, i, s, j: step_isolate(c, i, s, j, "music"), "captions": step_captions,
    "text": step_text, "logo": step_logo, "fade": step_fade, "resize": step_resize, "rotate": step_rotate,
    "compress": step_compress, "gif": step_gif, "extract_audio": step_extract_audio, "thumbnail": step_thumbnail,
    "convert": step_convert, "remove_silence": step_remove_silence, "remove_fillers": step_remove_fillers,
    "speed_ramp": step_speed_ramp, "slow_motion": step_slow_motion, "look": step_look, "montage": step_montage,
    "remove_background": step_remove_background, "upscale": step_upscale
}
FINAL_STEPS = {"gif", "extract_audio", "thumbnail"}
ALIASES = {"crop_vertical": "reframe", "vertical": "reframe", "denoise": "clean_speech", "remove_noise": "clean_speech",
           "music": "add_music", "subtitles": "captions", "watermark": "logo", "remove_music": "keep_voice",
           "instrumental": "remove_voice", "concat": "join", "loudness": "normalize", "cut_silence": "remove_silence",
           "remove_pauses": "remove_silence", "cut_fillers": "remove_fillers", "filter": "look", "color": "look",
           "slowmo": "slow_motion", "beat_sync": "montage", "green_screen": "remove_background", "enhance": "upscale"}


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
            if cur != src and os.path.splitext(cur)[1] in (".gif", ".jpg", ".png", ".mp3", ".wav", ".flac") and op not in ("convert", "upscale", "remove_background"):
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
        result["info"] = probe(final) if not final.endswith((".jpg", ".png", ".srt")) else {}
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
    transcript = transcript_of(src, spec.get("language"), translate=bool(spec.get("translate")))
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


COMMANDS = {"edit": edit, "transcribe": transcribe, "find": find, "separate": separate, "highlights": highlights, "speak": speak}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    try:
        if cmd == "info":
            result = {"ok": True, "file": argv[2], **probe(media_path(argv[2]))}
        elif cmd in COMMANDS:
            with open(media_path(argv[2]), encoding="utf-8") as f:
                spec = json.load(f)
            result = COMMANDS[cmd](spec)
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
