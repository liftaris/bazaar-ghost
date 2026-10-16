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
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
WORKDIR /app
COPY --from=denoland/deno:bin-2.9.5 /deno /usr/local/bin/deno
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --prefer-binary -r requirements.txt
RUN useradd -m -u 1000 sfde && chown sfde:sfde /app
USER sfde
# Cache exactly the models used at runtime, in the runtime user's home.
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(text_detection_model_name='PP-OCRv5_mobile_det', text_recognition_model_name='en_PP-OCRv5_mobile_rec', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)"
COPY --chown=sfde:sfde config.yaml .
COPY --chown=sfde:sfde src/ ./src/
COPY --chown=sfde:sfde streamlink_plugins/ ./streamlink_plugins/
COPY --chown=sfde:sfde templates/ ./templates/
ENTRYPOINT ["python", "-u", "src/sfde.py"]

FROM runtime AS test
USER root
COPY ffmpeg/verify.py /tmp/verify_ffmpeg.py
RUN python /tmp/verify_ffmpeg.py --ffmpeg /opt/ffmpeg/bin/ffmpeg
COPY requirements-test.txt .
RUN --mount=type=cache,target=/root/.cache/pip python -m pip install -r requirements-test.txt
COPY --chown=sfde:sfde tests/ ./tests/
COPY --chown=sfde:sfde pytest.ini .
USER sfde
ENTRYPOINT ["python", "-m", "pytest"]

FROM runtime AS production
