#!/usr/bin/env python3
"""Downloads the models into the codev-media image while it is built (its
containers run without a network). A step of its own, before codev_media.py
is copied in, so changing the editor doesn't download them all again."""
import os
import shutil
import sys
import time
import urllib.request

MODELS = os.environ.get("CODEV_MODELS_DIR", "/opt/models")
WHISPER_DIR = os.environ.get("CODEV_WHISPER_DIR", "/opt/models/whisper")
WHISPER_MODEL = os.environ.get("CODEV_WHISPER_MODEL", "small")
# Keep in step with PIPER_VOICES in codev_media.py.
PIPER_VOICES = ["en_US-lessac-medium", "en_US-ryan-medium", "en_US-amy-medium", "en_GB-alan-medium"]

MODEL_FILES = {
    "kokoro/kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "kokoro/voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    "rvm/rvm_mobilenetv3_fp32.torchscript": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.torchscript",
    "esrgan/realesr-general-x4v3.pth": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
}
for _name in PIPER_VOICES:
    _lang, _speaker, _quality = _name.split("-")
    for _ext in (".onnx", ".onnx.json"):
        MODEL_FILES[f"piper/{_name}{_ext}"] = (f"https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/{_lang.split('_')[0]}/{_lang}/{_speaker}/{_quality}/{_name}{_ext}")


def fetch(url, dest):
    import time
    import urllib.request
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(4):
        try:
            print(f"downloading {url}")
            with urllib.request.urlopen(url, timeout=120) as r, open(dest + ".part", "wb") as f:
                shutil.copyfileobj(r, f, 1024 * 1024)
            os.replace(dest + ".part", dest)
            return
        except Exception as err:
            print(f"  {err}; retrying", file=sys.stderr)
            time.sleep(2 ** attempt * 3)
    raise RuntimeError(f"couldn't download {url}")


def download_models():
    for rel, url in MODEL_FILES.items():
        if not os.path.isfile(os.path.join(MODELS, rel)):
            fetch(url, os.path.join(MODELS, rel))
    from rembg import new_session
    new_session("isnet-general-use")
    from faster_whisper import WhisperModel
    WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=WHISPER_DIR)
    from demucs.pretrained import get_model
    get_model("htdemucs")
    from df.enhance import init_df
    init_df(log_level="ERROR")
    return {"ok": True}




if __name__ == "__main__":
    download_models()
    print("models ready")
    sys.exit(0)
