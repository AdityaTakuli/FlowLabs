"""FlowLab local API: serves the web canvas and drives Code Mode on this machine."""

from .app import create_app
from .service import LabService, ServiceError

__all__ = ["LabService", "ServiceError", "create_app"]
