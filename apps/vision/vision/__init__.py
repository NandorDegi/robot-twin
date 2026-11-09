"""Vision service for the robot twin.

Run from this directory:

    .venv/bin/python -m vision

Endpoints
---------
GET /health      -> {"status": "ok"}
GET /stream      -> multipart/x-mixed-replace MJPEG feed
GET /detect      -> JSON: board + detected pieces
GET /calibrate   -> JSON: ArUco board pose (if a marker is visible)
"""
