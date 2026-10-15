# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
WORKDIR /app
COPY --from=denoland/deno:bin-2.9.7 /deno /usr/local/bin/deno
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt/lists \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 libgomp1 libgl1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --prefer-binary -r requirements.txt
RUN useradd -m -u 1000 sfde && chown sfde:sfde /app
USER sfde
# Cache exactly the models used at runtime, in the runtime user's home.
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(text_detection_model_name='PP-OCRv5_mobile_det', text_recognition_model_name='en_PP-OCRv5_mobile_rec', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False)"
COPY --chown=sfde:sfde config.yaml .
COPY --chown=sfde:sfde src/ ./src/
COPY --chown=sfde:sfde streamlink_plugins/ ./streamlink_plugins/
COPY --chown=sfde:sfde templates/ ./templates/
ENTRYPOINT ["python", "-u", "src/sfde.py"]

FROM runtime AS test
USER root
COPY requirements-test.txt .
RUN --mount=type=cache,target=/root/.cache/pip python -m pip install -r requirements-test.txt
COPY --chown=sfde:sfde tests/ ./tests/
COPY --chown=sfde:sfde pytest.ini .
USER sfde
ENTRYPOINT ["python", "-m", "pytest"]

FROM runtime AS production
