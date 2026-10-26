"""
JSON logging formatter for structured logging
"""

import json
import logging
from datetime import datetime, timezone
from opentelemetry import trace

class JSONFormatter(logging.Formatter):
    """Custom JSON formatter for structured logging"""

    # Context fields that should always be included when present
    # Note: environment comes from OTel resource attributes, not duplicated here
    CONTEXT_FIELDS = ['vod_id', 'chunk_id', 'streamer', 'quality']

    # Standard LogRecord attributes to exclude from extra fields
    STANDARD_ATTRS = {
        'name', 'msg', 'args', 'created', 'filename', 'funcName', 'levelname',
        'levelno', 'lineno', 'module', 'msecs', 'pathname', 'process',
        'processName', 'relativeCreated', 'stack_info', 'exc_info', 'exc_text',
        'thread', 'threadName', 'taskName', 'message'
    }

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON"""
        log_obj = {
            'timestamp': datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno
        }
        context = trace.get_current_span().get_span_context()
        if context.is_valid:
            log_obj['trace_id'] = format(context.trace_id, '032x')
            log_obj['span_id'] = format(context.span_id, '016x')

        # Add context fields from LoggerAdapter
        for field in self.CONTEXT_FIELDS:
            if hasattr(record, field):
                value = getattr(record, field)
                if value is not None:
                    log_obj[field] = value

        # Add any extra fields passed to the log call
        # This enables structured events like: logger.info("event", extra={'key': 'value'})
        for key, value in record.__dict__.items():
            if key not in self.STANDARD_ATTRS and key not in self.CONTEXT_FIELDS and not key.startswith('_'):
                if value is not None:
                    log_obj[key] = value

        # Add exception info if present
        if record.exc_info:
            log_obj['exception'] = self.formatException(record.exc_info)

        return json.dumps(log_obj)
