# CoDev's media image: the four free, open-source tools agents edit video and
# audio with, and codev_media.py, which turns plain recipe steps into them.
#   FFmpeg        cut, join, speed, crop, music, captions, text, logos, GIFs
#   Whisper       captions and transcripts (faster-whisper, the same models, faster on a CPU)
#   Demucs        splits a voice from music and other sounds (stems)
#   DeepFilterNet removes background noise from speech
# and the extras: Kokoro and Piper voices, RobustVideoMatting and rembg for
# backgrounds, Real-ESRGAN for upscaling, librosa for beats.
# The models are downloaded while the image is built, because the containers
# run without a network. CPU only, so it works on any PC.
FROM python:3.11-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core git \
 && rm -rf /var/lib/apt/lists/* && fc-cache -f

# git: DeepFilterNet looks up its version with it.
# Torch 2.0 is the last one DeepFilterNet 0.5 runs on; Demucs is happy with it too.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.0.1 torchaudio==2.0.2 \
 && pip install --no-cache-dir "numpy<2" faster-whisper==1.1.1 demucs==4.0.1 deepfilternet==0.5.6 soundfile==0.12.1 \
      piper-tts==1.8.0 rembg==2.0.69 librosa==0.11.0 pillow \
 && pip install --no-cache-dir "numpy<2" onnxruntime==1.20.1 phonemizer-fork==3.3.2 espeakng-loader==0.2.4 colorlog==6.9.0 \
 && pip install --no-cache-dir --no-deps kokoro-onnx==0.4.9
# Kokoro 1.0 (its voices include Kore, CoDev's default) asks pip for numpy 2, but runs on
# the numpy 1 that Torch 2.0 needs, so it goes in without its own requirements.

ENV TORCH_HOME=/opt/models/torch \
    XDG_CACHE_HOME=/opt/models/cache \
    HF_HOME=/opt/models/hf \
    U2NET_HOME=/opt/models/u2net \
    CODEV_MODELS_DIR=/opt/models \
    NUMBA_CACHE_DIR=/tmp/numba \
    CODEV_WHISPER_DIR=/opt/models/whisper \
    PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=4

COPY download_models.py /app/download_models.py
RUN python /app/download_models.py && chmod -R a+rX /opt/models
COPY codev_media.py /app/codev_media.py

LABEL org.opencontainers.image.source="https://github.com/phillbennett021423/CoDev_cloud" \
      org.opencontainers.image.description="FFmpeg, Whisper, Demucs and DeepFilterNet for CoDev's video and audio editing"
WORKDIR /media
ENTRYPOINT ["python", "/app/codev_media.py"]
