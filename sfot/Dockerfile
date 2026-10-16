# syntax=docker/dockerfile:1.7
FROM python:3.11-slim-bookworm AS ffmpeg-build
ARG FFMPEG_VERSION=8.0.3
ARG FFMPEG_SHA256=6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818
# Build on the same distribution as Paddle/Python; retain native codecs and filters.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl nasm pkg-config xz-utils \
        libgnutls28-dev libdav1d-dev libx264-dev zlib1g-dev
WORKDIR /tmp/ffmpeg-build
RUN curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
        "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o ffmpeg.tar.xz \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum --check --strict \
    && tar -xJf ffmpeg.tar.xz --strip-components=1 \
    && ./configure --prefix=/opt/ffmpeg --disable-debug --disable-doc --disable-ffplay \
        --disable-autodetect --disable-shared --enable-static \
        --enable-gnutls --enable-libdav1d --enable-gpl --enable-libx264 --enable-zlib \
    && make -j2 && make install

FROM python:3.11-slim-bookworm AS ffmpeg
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libgnutls30 libdav1d6 libx264-164 zlib1g \
    && rm -rf /var/lib/apt/lists/*
# FFmpeg libraries link into these executables; Python's shared libraries are unchanged.
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ /opt/ffmpeg/bin/
ENV PATH="/opt/ffmpeg/bin:${PATH}"
RUN ffmpeg -version && ffprobe -version

FROM ffmpeg AS ffmpeg-test
COPY ffmpeg/verify.py /tmp/verify_ffmpeg.py
RUN python /tmp/verify_ffmpeg.py --ffmpeg /opt/ffmpeg/bin/ffmpeg

FROM ffmpeg AS runtime

# Keep apt quiet & lean; keep pip quick and cached
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1


# OS deps (cache apt metadata; no dev pkgs)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        libgomp1 \
        wget \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

# Faster pip installs via BuildKit cache mount, prefer wheels
RUN --mount=type=cache,target=/root/.cache/pip \
      python -m pip install --upgrade pip \
   && python -m pip install --prefer-binary -r requirements.txt \
   && pip install opentelemetry-distro opentelemetry-exporter-otlp \
   && opentelemetry-bootstrap --action=install

# Pre-download PaddleOCR mobile models
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='en', text_detection_model_name='PP-OCRv5_mobile_det', text_recognition_model_name='en_PP-OCRv5_mobile_rec', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)"

# Copy the rest (use --chown to avoid a later chown layer)
COPY --chown=1000:1000 config.yaml .
COPY --chown=1000:1000 src/ ./src/
COPY --chown=1000:1000 templates/ ./templates/

# Create health file and set up user permissions
RUN echo "ok" > /app/health && \
    useradd -m -u 1000 sfot && \
    cp -r /root/.paddlex /home/sfot/.paddlex && \
    chown -R sfot:sfot /app /home/sfot/.paddlex

# Switch to non-root user
USER sfot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD [ -f /app/health ] || exit 1

ENTRYPOINT ["python", "-u", "src/sfot.py"]
