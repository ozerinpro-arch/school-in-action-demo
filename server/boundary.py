"""Same-origin, local-only request boundary for the demo."""
from starlette.responses import JSONResponse

MAX_BODY_BYTES = 64 * 1024
ALLOWED_HOSTS = {"127.0.0.1:5188", "localhost:5188"}
ALLOWED_ORIGINS = {f"http://{host}" for host in ALLOWED_HOSTS}


class LocalBoundaryMiddleware:
    """Check exact local Host/Origin and bound bodies before parsing JSON."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {}
        for key, value in scope["headers"]:
            name = key.decode("latin1").lower()
            # Duplicate security headers are ambiguous and therefore refused.
            if name in headers and name in {"host", "origin", "content-length"}:
                await JSONResponse({"detail": "Ambiguous request headers."}, status_code=400)(scope, receive, send)
                return
            headers[name] = value.decode("latin1")
        if headers.get("host", "").lower() not in ALLOWED_HOSTS:
            await JSONResponse({"detail": "Open the demo on its local address."}, status_code=403)(scope, receive, send)
            return
        origin = headers.get("origin")
        if (origin is not None and origin not in ALLOWED_ORIGINS) or headers.get("sec-fetch-site") == "cross-site":
            await JSONResponse({"detail": "Cross-site requests are blocked."}, status_code=403)(scope, receive, send)
            return
        limit = MAX_BODY_BYTES
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > limit:
            await JSONResponse({"detail": "Request body is too large or has an invalid length."}, status_code=413)(scope, receive, send)
            return
        chunks = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > limit:
                await JSONResponse({"detail": "Request body is too large."}, status_code=413)(scope, receive, send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        expected_type = "application/json"
        if body and scope["method"] in {"POST", "PUT", "PATCH"} and headers.get("content-type", "").split(";", 1)[0].strip().lower() != expected_type:
            await JSONResponse({"detail": "Send the request as JSON."}, status_code=415)(scope, receive, send)
            return
        delivered = False

        async def replay_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        async def security_send(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).extend([
                    (b"x-content-type-options", b"nosniff"),
                    (b"cache-control", b"no-store"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-frame-options", b"DENY"),
                    (b"content-security-policy", b"default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
                ])
            await send(message)

        await self.app(scope, replay_receive, security_send)
