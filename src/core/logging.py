"""Where application logs go — the one place that decides.

Nothing configured the root logger before this module existed. Under uvicorn
only the ``uvicorn.*`` loggers get handlers, so everything logged by ``core.*``,
``identity.*`` and ``ledger.*`` fell through to :data:`logging.lastResort`:
bare messages on stderr, no timestamp, no level, no logger name — and anything
below WARNING dropped silently. That is how a mail outage stays invisible. The
failure was logged all along; there was simply nowhere for it to come out.
"""

import logging
from logging.config import dictConfig

from core.config import get_settings

_configured = False


def configure_logging(level: str | None = None, *, force: bool = False) -> None:
    """Attach a formatter and a stderr handler to the root logger.

    Idempotent: the API imports the composition root once, but the tests and
    the CLI can both call this without stacking duplicate handlers.
    """
    global _configured
    if _configured and not force:
        return

    resolved = (level or get_settings().log_level).upper()
    if resolved not in logging.getLevelNamesMapping():
        resolved = "INFO"

    dictConfig(
        {
            "version": 1,
            # uvicorn configures its own loggers before we get here; leaving
            # them enabled keeps the access log working.
            "disable_existing_loggers": False,
            "formatters": {
                "piggy": {
                    "format": "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
                    "datefmt": "%Y-%m-%d %H:%M:%S",
                }
            },
            "handlers": {
                "stderr": {
                    "class": "logging.StreamHandler",
                    "stream": "ext://sys.stderr",
                    "formatter": "piggy",
                }
            },
            "root": {"handlers": ["stderr"], "level": resolved},
        }
    )
    _configured = True
