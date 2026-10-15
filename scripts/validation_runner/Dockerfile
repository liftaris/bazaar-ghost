# Extend the already-tested OCR runtime; no Docker daemon is installed or exposed.
ARG BASE_IMAGE=sfde:runtime
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git libicu72 libssl3 libkrb5-3 zlib1g \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /runner
# Official actions/runner v2.338.0 linux-x64 release checksum.
RUN curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
      https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz -o /tmp/runner.tar.gz \
    && echo 'af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32  /tmp/runner.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/runner.tar.gz && rm /tmp/runner.tar.gz \
    && chown -R sfde:sfde /runner
COPY --chmod=755 guard.sh /opt/bazaarghost-runner/guard.sh
COPY guard.py start.py /opt/bazaarghost-runner/
ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/bazaarghost-runner/guard.sh
USER sfde
ENTRYPOINT ["python", "-u", "/opt/bazaarghost-runner/start.py"]
