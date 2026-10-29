# CoDev's media image: the four free, open-source tools agents edit video and
# audio with, and codev_media.py, which turns plain recipe steps into them.
#   FFmpeg        cut, join, speed, crop, music, captions, text, logos, GIFs
#   Whisper       captions and transcripts (faster-whisper, the same models, faster on a CPU)
#   Demucs        splits a voice from music and other sounds (stems)
#   DeepFilterNet removes background noise from speech
# The models are downloaded while the image is built, because the containers
# run without a network. CPU only, so it works on any PC.
FROM python:3.11-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* && fc-cache -f

# Torch 2.0 is the last one DeepFilterNet 0.5 runs on; Demucs is happy with it too.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.0.1 torchaudio==2.0.2 \
 && pip install --no-cache-dir "numpy<2" faster-whisper==1.1.1 demucs==4.0.1 deepfilternet==0.5.6 soundfile==0.12.1

ENV TORCH_HOME=/opt/models/torch \
    XDG_CACHE_HOME=/opt/models/cache \
    HF_HOME=/opt/models/hf \
    CODEV_WHISPER_DIR=/opt/models/whisper \
    PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=4

COPY codev_media.py /app/codev_media.py
RUN python /app/codev_media.py download-models && chmod -R a+rX /opt/models

LABEL org.opencontainers.image.source="https://github.com/phillbennett021423/CoDev_cloud" \
      org.opencontainers.image.description="FFmpeg, Whisper, Demucs and DeepFilterNet for CoDev's video and audio editing"
WORKDIR /media
ENTRYPOINT ["python", "/app/codev_media.py"]
