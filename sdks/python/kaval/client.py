"""HTTP client for the kaval REST surface. Mirrors the TS SDK contract.

The primary loop for payer-policy monitoring: register a source with :meth:`KavalClient.add_source`,
bind an ``ExtractionSchema`` to it (:meth:`KavalClient.create_extraction_schema` +
:meth:`KavalClient.update_source`), and subscribe to ``policy_update.*`` webhooks with
:meth:`KavalClient.subscribe_policy_updates` so structured records and monthly packages are pushed
to you as documents land.

:meth:`KavalClient.check` is the other half of the product: before an agent acts, send the action
and get ALLOW, REVIEW, or BLOCK with a signed receipt. Push your own documents with
:meth:`KavalClient.send_event`, and subscribe to ``fact_state.delta`` webhooks with
:meth:`KavalClient.subscribe_fact_state_deltas` so you are told when a fact flips instead of
polling for it.
"""

from __future__ import annotations

from concurrent.futures import CancelledError
import os
from threading import Event, Lock, Thread
from urllib.parse import quote
import uuid
from typing import (
    Any,
    Callable,
    Literal,
    Mapping,
    Optional,
    Sequence,
    TypeAlias,
    TypeVar,
    cast,
)

import httpx

from .models import (
    FACT_STATE_DELTA_EVENT_TYPE,
    POLICY_UPDATE_EVENT_TYPES,
    ActionReversibility,
    AddSourceResult,
    CheckMode,
    CheckReceipt,
    CheckResult,
    ClaimInput,
    CreateExtractionSchemaInput,
    CreatePolicyUpdateInput,
    CreateWebhookResult,
    EvidenceRef,
    ExtractionRun,
    ExtractionSchema,
    Materiality,
    PolicyUpdatePackage,
    RecompileSourceResult,
    SourceEventResult,
    SourceVersionContent,
    SourceVersionSections,
    VerifyResult,
    WatchedSource,
    WatchedSourceKind,
    WebhookSubscription,
    WebhookSubscriptionKind,
)

OutcomeKind = Literal[
    "current_later_contradicted",
    "stale_caught_real",
    "stale_was_false_alarm",
    "relied_and_correct",
]

# The hosted kaval cloud. Override with `base_url=...` to point at a self-hosted `kaval-server`.
DEFAULT_BASE_URL = "https://api.usekaval.com"

# Above the server's own handler deadline (REQUEST_TIMEOUT_MS = 150_000), which already sits above
# the 100s research budget a cold check is allowed to spend. At 30s this client aborted the
# quickstart's very first call — a cold action check routinely needs ~50-100s of live research, so
# the caller saw a TimeoutException where the server was about to answer.
DEFAULT_TIMEOUT_SECONDS = 150.0

MAX_BILLABLE_ATTEMPTS = 2
AMBIGUOUS_IDEMPOTENCY_CODES = {
    "idempotency_in_progress",
    "idempotency_resolution_pending",
    "event_persistence_pending",
}


class NoTimeout:
    """Type of the :data:`NO_TIMEOUT` sentinel."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - diagnostic only
        return "kaval.NO_TIMEOUT"


#: Pass as ``timeout=`` to run one call with NO deadline. ``timeout=None`` already means "inherit
#: the client's", so there was previously no value a caller could pass to disable it — the TS
#: client's ``timeoutMs: null`` had no Python equivalent. Use it for a cold check you would rather
#: wait out than lose.
NO_TIMEOUT = NoTimeout()

#: A per-call deadline: seconds, ``NO_TIMEOUT`` to disable it, or ``None`` to inherit the client's.
RequestTimeout: TypeAlias = float | NoTimeout | None


class KavalError(Exception):
    """Raised when the API returns a non-2xx response."""

    def __init__(
        self, status_code: int, payload: Any, *, idempotency_key: Optional[str] = None
    ) -> None:
        super().__init__(f"kaval {status_code}: {payload}")
        self.status_code = status_code
        self.payload = payload
        self.idempotency_key = idempotency_key


class KavalRetiredError(KavalError):
    """Raised when the API answers ``410 tool_retired``.

    Every pre-0.6 verification endpoint (``/v1/audit``, ``/v1/gate``, ``/v1/kaval``,
    ``/v1/scan-store``, ``/v1/extract-and-check``, ``/v1/monitor``, and the belief routes)
    collapsed into ``POST /v1/check``. The message names :meth:`KavalClient.check` explicitly
    rather than leaving an agent to guess at an unexplained HTTP error.
    """

    code = "tool_retired"

    def __init__(
        self,
        payload: Any,
        path: str,
        *,
        idempotency_key: Optional[str] = None,
    ) -> None:
        replacement = payload.get("replacement") if isinstance(payload, dict) else None
        if not isinstance(replacement, str) or not replacement:
            replacement = "/v1/check"
        super().__init__(410, payload, idempotency_key=idempotency_key)
        self.replacement = replacement
        # KavalError's generic "kaval 410: {payload}" would bury the one thing the caller needs.
        self.args = (
            f"kaval 410: {path} was retired in v0.6 — use {replacement} "
            "(the check() method) instead. One call verifies the facts an action depends on "
            "and returns ALLOW, REVIEW, or BLOCK with a signed receipt.",
        )


class KavalCancelledError(CancelledError):
    """Raised when a caller cancels a synchronous Kaval operation."""

    def __init__(
        self,
        reason: object = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> None:
        if reason is None:
            message = "kaval operation cancelled"
        elif isinstance(reason, BaseException):
            message = str(reason) or reason.__class__.__name__
        else:
            message = str(reason)
        super().__init__(message)
        self.reason = reason
        self.idempotency_key = idempotency_key


class KavalCancellationToken:
    """Thread-safe, one-shot cancellation signal for synchronous Kaval calls.

    Call ``cancel()`` from another thread to release a caller blocked on HTTP I/O. The first
    cancellation wins and its optional reason is exposed on ``KavalCancelledError``.
    """

    def __init__(self) -> None:
        self._event = Event()
        self._lock = Lock()
        self._reason: object = None
        self._callbacks: dict[int, Callable[[], None]] = {}
        self._next_callback_id = 0

    @property
    def cancelled(self) -> bool:
        """Whether cancellation has been requested."""
        return self._event.is_set()

    @property
    def reason(self) -> object:
        """The first reason passed to ``cancel()``, or ``None``."""
        with self._lock:
            return self._reason

    def cancel(self, reason: object = None) -> bool:
        """Cancel once, returning ``True`` only for the call that changed state."""
        with self._lock:
            if self._event.is_set():
                return False
            self._reason = reason
            self._event.set()
            callbacks = list(self._callbacks.values())
            self._callbacks.clear()
        for callback in callbacks:
            try:
                callback()
            except Exception:
                # Cancellation must remain reliable even if best-effort transport cleanup fails.
                pass
        return True

    def wait(self, timeout: Optional[float] = None) -> bool:
        """Wait until cancelled, returning ``False`` if ``timeout`` elapses first."""
        return self._event.wait(timeout)

    def raise_if_cancelled(self) -> None:
        """Raise ``KavalCancelledError`` when cancellation has been requested."""
        self._raise_if_cancelled()

    def _raise_if_cancelled(self, idempotency_key: Optional[str] = None) -> None:
        if self._event.is_set():
            raise KavalCancelledError(
                self.reason,
                idempotency_key=idempotency_key,
            )

    def _register(self, callback: Callable[[], None]) -> Callable[[], None]:
        with self._lock:
            if self._event.is_set():
                callback_id: Optional[int] = None
            else:
                callback_id = self._next_callback_id
                self._next_callback_id += 1
                self._callbacks[callback_id] = callback
        if callback_id is None:
            try:
                callback()
            except Exception:
                pass

        def unregister() -> None:
            if callback_id is not None:
                with self._lock:
                    self._callbacks.pop(callback_id, None)

        return unregister


_ResultT = TypeVar("_ResultT")


def _safe_call(callback: Callable[[], None]) -> None:
    try:
        callback()
    except Exception:
        pass


def _run_cleanup(callback: Callable[[], None]) -> None:
    """Start best-effort cleanup without delaying the cancelled caller.

    A synchronous transport's public ``close()`` hook is allowed to block. Cleanup therefore
    belongs to a daemon worker after cancellation: the operation's finite httpx timeout remains
    the backstop for a transport that cannot be interrupted by close.
    """

    try:
        Thread(
            target=lambda: _safe_call(callback),
            name="kaval-cancellable-cleanup",
            daemon=True,
        ).start()
    except RuntimeError:
        # Thread exhaustion must not turn best-effort cleanup into a blocking cancellation path.
        pass


def _once(callback: Callable[[], None]) -> Callable[[], None]:
    """Return a thread-safe callback that invokes ``callback`` at most once."""

    lock = Lock()
    called = False

    def invoke() -> None:
        nonlocal called
        with lock:
            if called:
                return
            called = True
        callback()

    return invoke


def _run_cancellable(
    operation: Callable[[], _ResultT],
    cancellation_token: Optional[KavalCancellationToken],
    *,
    idempotency_key: Optional[str] = None,
    dispose_late: Optional[Callable[[_ResultT], None]] = None,
    on_cancel: Optional[Callable[[], None]] = None,
) -> _ResultT:
    """Run blocking sync I/O while allowing another thread to release this caller.

    httpx has no AbortSignal equivalent for its synchronous transport. A daemon worker owns the
    blocking call; cancellation wakes the caller immediately, prevents retries, and requests
    closure of any response that is already available or arrives later. A finite transport timeout
    remains the portable cleanup backstop when public close cannot interrupt a blocking I/O call.
    """
    if cancellation_token is None:
        return operation()
    if cancellation_token.cancelled:
        if on_cancel is not None:
            _run_cleanup(on_cancel)
        cancellation_token._raise_if_cancelled(idempotency_key)

    wake = Event()
    state_lock = Lock()
    outcome: list[tuple[bool, Any]] = []
    abandoned = [False]

    def worker() -> None:
        try:
            cancellation_token._raise_if_cancelled(idempotency_key)
            value: Any = operation()
            completed = (True, value)
        except BaseException as error:
            completed = (False, error)

        late_value: Any = None
        should_dispose = False
        with state_lock:
            if abandoned[0]:
                if completed[0] and dispose_late is not None:
                    late_value = completed[1]
                    should_dispose = True
            else:
                outcome.append(completed)
        if should_dispose and dispose_late is not None:
            disposer = dispose_late
            _safe_call(lambda: disposer(late_value))
        wake.set()

    unregister = cancellation_token._register(wake.set)
    if cancellation_token.cancelled:
        unregister()
        if on_cancel is not None:
            _run_cleanup(on_cancel)
        cancellation_token._raise_if_cancelled(idempotency_key)

    Thread(target=worker, name="kaval-cancellable-http", daemon=True).start()
    wake.wait()
    unregister()

    value_to_dispose: Any = None
    should_dispose = False
    with state_lock:
        if cancellation_token.cancelled:
            abandoned[0] = True
            if outcome:
                completed = outcome.pop()
                if completed[0] and dispose_late is not None:
                    value_to_dispose = completed[1]
                    should_dispose = True
            completed = None
        else:
            completed = outcome.pop() if outcome else None

    if cancellation_token.cancelled:
        if on_cancel is not None:
            _run_cleanup(on_cancel)
        if should_dispose and dispose_late is not None:
            disposer = dispose_late
            _run_cleanup(lambda: disposer(value_to_dispose))
        cancellation_token._raise_if_cancelled(idempotency_key)

    if completed is None:
        raise RuntimeError("cancellable operation completed without an outcome")
    if completed[0]:
        return cast(_ResultT, completed[1])
    raise completed[1]


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    """Drop None-valued keys so optional params are omitted from the request."""
    return {k: v for k, v in body.items() if v is not None}


def _api_error_code(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


def _is_retired_payload(payload: Any) -> bool:
    """The retired-route body is a FLAT ``{"error": "tool_retired"}``, not ``{"error": {code}}``."""
    return isinstance(payload, dict) and payload.get("error") == "tool_retired"


def _attach_idempotency_key(error: BaseException, operation_key: str) -> None:
    """Attach a recovery diagnostic without changing the exception's public type."""
    setattr(error, "idempotency_key", operation_key)


def _path_segment(value: str, *, name: str) -> str:
    """URL-encode one path segment, refusing an empty id before any network call."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} is required")
    return quote(value.strip(), safe="")


_CHECK_REQUEST_FIELDS = {
    "action",
    "context",
    "claims",
    "mode",
    "max_wait_ms",
    "origin_urls",
    "materiality",
    "as_of",
}

_VERIFY_REQUEST_FIELDS = {
    "conclusion",
    "evidence_refs",
    "as_of",
    "materiality",
    "intended_action",
    "reversibility",
    "jurisdiction",
    "context",
}
_VERIFY_STATUSES = {"valid", "invalidated", "could_not_verify"}
_VERIFY_DECISIONS = {"ALLOW", "BLOCK", "REVIEW"}


def _validated_evidence_refs(evidence_refs: Any) -> list[Any]:
    """Fail fast on the wire contract's sharp edges before spending a billable request.

    Each reference is EITHER a plain URL string OR a strict ``{url, document_id}`` object;
    a bare object without ``document_id`` is invalid, and ``document_id`` values must be
    unique across the request. The server owns URL semantics (https, length bounds).
    """
    if isinstance(evidence_refs, (str, bytes)) or not isinstance(
        evidence_refs, Sequence
    ):
        raise ValueError("evidence_refs must be a list of 1 to 20 evidence references")
    refs = list(evidence_refs)
    if not 1 <= len(refs) <= 20:
        raise ValueError("evidence_refs must contain between 1 and 20 references")
    normalized: list[Any] = []
    document_ids: list[str] = []
    for reference in refs:
        if isinstance(reference, str):
            normalized.append(reference)
            continue
        if isinstance(reference, Mapping):
            if "document_id" not in reference:
                raise ValueError(
                    "an evidence_refs object requires document_id; "
                    "pass a plain URL string instead"
                )
            url = reference.get("url")
            document_id = reference.get("document_id")
            if (
                set(reference.keys()) != {"url", "document_id"}
                or not isinstance(url, str)
                or not isinstance(document_id, str)
                or not document_id
            ):
                raise ValueError(
                    "an evidence_refs object must be exactly "
                    "{url: str, document_id: str}"
                )
            document_ids.append(document_id)
            normalized.append({"url": url, "document_id": document_id})
            continue
        raise ValueError(
            "each evidence reference must be a URL string or {url, document_id}"
        )
    if len(set(document_ids)) != len(document_ids):
        raise ValueError("evidence_refs document_id values must be unique")
    return normalized


def _verify_result(payload: Any) -> VerifyResult:
    """Fail closed if a drifted response could be mistaken for a verification verdict."""
    receipt = payload.get("receipt") if isinstance(payload, dict) else None
    valid = (
        isinstance(payload, dict)
        and payload.get("status") in _VERIFY_STATUSES
        and isinstance(receipt, dict)
        and isinstance(receipt.get("proof_id"), str)
        and bool(receipt["proof_id"])
        and receipt.get("decision") in _VERIFY_DECISIONS
        and isinstance(receipt.get("reason"), str)
        and isinstance(receipt.get("share_endpoint"), str)
        and isinstance(receipt.get("packet"), dict)
    )
    if not valid:
        raise TypeError(
            "verify returned an invalid conclusion-verification envelope; "
            "expected {status, receipt{proof_id, decision, reason, share_endpoint, packet}}"
        )
    return cast(VerifyResult, payload)


class KavalClient:
    """Synchronous client for Kaval's verification surface.

    ``check()`` is the whole product: send the action an agent is about to take (or the claims it
    rests on) and get ALLOW / REVIEW / BLOCK plus a signed receipt. Everything else configures
    what Kaval watches so that a check stays a warm database read instead of a research run.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        *,
        timeout: float | NoTimeout = DEFAULT_TIMEOUT_SECONDS,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        resolved_base = base_url or os.environ.get("KAVAL_BASE_URL") or DEFAULT_BASE_URL
        resolved_key = (
            api_key if api_key is not None else os.environ.get("KAVAL_API_KEY")
        )
        headers = {"content-type": "application/json"}
        if resolved_key:
            headers["authorization"] = f"Bearer {resolved_key}"
        self._http = httpx.Client(
            base_url=resolved_base.rstrip("/"),
            headers=headers,
            timeout=None if isinstance(timeout, NoTimeout) else timeout,
            transport=transport,
        )

    # ------------------------------------------------------------------ transport

    def _send_response(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        *,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
        idempotency_key: Optional[str] = None,
    ) -> httpx.Response:
        request_options: dict[str, Any] = {}
        if timeout is not None:
            # httpx spells "no deadline" as None, which is already taken here for "inherit".
            request_options["timeout"] = (
                None if isinstance(timeout, NoTimeout) else timeout
            )
        if cancellation_token is None:
            return self._http.request(
                method,
                path,
                json=body,
                params=params,
                headers=headers,
                **request_options,
            )

        def send() -> httpx.Response:
            request = self._http.build_request(
                method,
                path,
                json=body,
                params=params,
                headers=headers,
                **request_options,
            )
            return self._http.send(request, stream=True)

        response = _run_cancellable(
            send,
            cancellation_token,
            idempotency_key=idempotency_key,
            dispose_late=lambda late_response: late_response.close(),
        )
        close_response = _once(response.close)
        try:
            _run_cancellable(
                response.read,
                cancellation_token,
                idempotency_key=idempotency_key,
                on_cancel=close_response,
            )
        except BaseException:
            if cancellation_token.cancelled:
                _run_cleanup(close_response)
            else:
                _safe_call(close_response)
            raise
        return response

    def _billable_post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> Any:
        operation_key = idempotency_key or str(uuid.uuid4())
        if cancellation_token is not None:
            cancellation_token._raise_if_cancelled(operation_key)
        for attempt in range(MAX_BILLABLE_ATTEMPTS):
            try:
                res = self._send_response(
                    "POST",
                    path,
                    body,
                    headers={"idempotency-key": operation_key},
                    timeout=timeout,
                    cancellation_token=cancellation_token,
                    idempotency_key=operation_key,
                )
            except httpx.TransportError as error:
                _attach_idempotency_key(error, operation_key)
                # The server may have committed before the connection failed. Retry once with the
                # same key so a completed operation is replayed instead of billed twice.
                if attempt + 1 < MAX_BILLABLE_ATTEMPTS and not (
                    cancellation_token is not None and cancellation_token.cancelled
                ):
                    continue
                raise
            try:
                if cancellation_token is not None:
                    cancellation_token._raise_if_cancelled(operation_key)
                try:
                    payload: Any = res.json()
                except ValueError as error:
                    # Successful responses promise JSON. Preserve that contract instead of
                    # returning an unexpected string that callers may treat as a valid verdict.
                    # Error responses can come from a proxy as plain text, so retain their body.
                    if 200 <= res.status_code < 300:
                        _attach_idempotency_key(error, operation_key)
                        raise
                    payload = res.text
                if cancellation_token is not None:
                    cancellation_token._raise_if_cancelled(operation_key)
                if 200 <= res.status_code < 300:
                    return payload
                if res.status_code == 410 and _is_retired_payload(payload):
                    raise KavalRetiredError(
                        payload, path, idempotency_key=operation_key
                    )
                if (
                    attempt + 1 < MAX_BILLABLE_ATTEMPTS
                    and _api_error_code(payload) in AMBIGUOUS_IDEMPOTENCY_CODES
                ):
                    continue
                raise KavalError(
                    res.status_code,
                    payload,
                    idempotency_key=operation_key,
                )
            finally:
                if cancellation_token is not None and cancellation_token.cancelled:
                    _run_cleanup(res.close)
                else:
                    _safe_call(res.close)
        raise RuntimeError("unreachable billable request state")

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        *,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> Any:
        """One request, no idempotency key. Reads, and routes the server treats as reads."""
        try:
            res = self._send_response(
                method,
                path,
                body,
                params=params,
                headers=headers,
                timeout=timeout,
                cancellation_token=cancellation_token,
            )
        except httpx.TransportError:
            if cancellation_token is not None:
                cancellation_token._raise_if_cancelled()
            raise
        try:
            if cancellation_token is not None:
                cancellation_token._raise_if_cancelled()
            try:
                payload: Any = res.json()
            except ValueError:
                payload = res.text
            if cancellation_token is not None:
                cancellation_token._raise_if_cancelled()
            if res.status_code >= 400:
                if res.status_code == 410 and _is_retired_payload(payload):
                    raise KavalRetiredError(payload, path)
                raise KavalError(res.status_code, payload)
            return payload
        finally:
            if cancellation_token is not None and cancellation_token.cancelled:
                _run_cleanup(res.close)
            else:
                _safe_call(res.close)

    # ------------------------------------------------------------------ the one call

    def check(
        self,
        input_mapping: Optional[Mapping[str, Any]] = None,
        *,
        action: Optional[str] = None,
        context: Optional[str] = None,
        claims: Optional[Sequence[ClaimInput]] = None,
        mode: Optional[CheckMode] = None,
        max_wait_ms: Optional[int] = None,
        origin_urls: Optional[list[str]] = None,
        materiality: Optional[Materiality] = None,
        as_of: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> CheckResult:
        """Verify the facts an action depends on, before acting on it.

        Pass either a single request mapping (``check({"action": ...})``) or the same fields as
        keywords — never both. Send ``action`` (what the agent is about to do) and optionally
        ``context``, or send ``claims`` directly when you already know which facts matter. Kaval
        compiles the action into atomic facts, answers each from watched-source state (warm: no
        model call, no fetch), falls back to bounded live research for anything stale or novel,
        and returns:

        - ``decision`` — **ALLOW** (every material fact still holds on a fresh basis), **REVIEW**
          (something is unknown, changed at low/medium materiality, or mid-re-evaluation), or
          **BLOCK** (a high/critical fact changed, or a critical fact is unknown).
        - ``reason_codes`` — why, from a closed eight-code taxonomy.
        - ``facts`` — one row per fact with its status and the sources it rests on.
        - ``receipt`` — the id + Ed25519 signature of a document that re-derives this verdict
          offline; fetch the full document with :meth:`get_receipt`.
        - ``latency_ms`` — ``compile`` / ``lookup`` / ``live`` / ``total``.

        Only ALLOW means "safe to act". REVIEW is never permission to act.

        A check is a read of current state, so the server deliberately does NOT replay it under an
        idempotency key — this call sends none, and a retry is free to recompute.
        """
        field_kwargs: dict[str, Any] = {
            "action": action,
            "context": context,
            "claims": claims,
            "mode": mode,
            "max_wait_ms": max_wait_ms,
            "origin_urls": origin_urls,
            "materiality": materiality,
            "as_of": as_of,
        }
        if input_mapping is not None:
            if not isinstance(input_mapping, Mapping):
                # The pre-0.6 signature was check("<belief>"); say where that text goes now.
                raise ValueError(
                    "check takes a request mapping or keyword fields; pass a plain sentence "
                    "as check(action=...) or check(claims=[...])"
                )
            if any(value is not None for value in field_kwargs.values()):
                raise ValueError(
                    "pass the check request as one mapping or as keyword fields, not both"
                )
            unknown = set(input_mapping.keys()) - _CHECK_REQUEST_FIELDS
            if unknown:
                raise ValueError(
                    "unknown check request fields: " + ", ".join(sorted(unknown))
                )
            field_kwargs = {
                name: input_mapping.get(name) for name in field_kwargs
            }
        if field_kwargs["action"] is None and field_kwargs["claims"] is None:
            raise ValueError("check requires at least one of action or claims")
        body = _clean(
            {
                "action": field_kwargs["action"],
                "context": field_kwargs["context"],
                "claims": (
                    list(field_kwargs["claims"])
                    if field_kwargs["claims"] is not None
                    else None
                ),
                "mode": field_kwargs["mode"],
                "max_wait_ms": field_kwargs["max_wait_ms"],
                "origin_urls": field_kwargs["origin_urls"],
                "materiality": field_kwargs["materiality"],
                "as_of": field_kwargs["as_of"],
            }
        )
        return cast(
            CheckResult,
            self._request(
                "POST",
                "/v1/check",
                body,
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def get_receipt(
        self,
        receipt_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> CheckReceipt:
        """Fetch a signed check receipt exactly as it was signed, by ``result["receipt"]["id"]``."""
        payload = self._request(
            "GET",
            f"/v1/receipts/{_path_segment(receipt_id, name='receipt_id')}",
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(CheckReceipt, payload["receipt"])

    # ------------------------------------------------------------------ sources

    def add_source(
        self,
        kind: WatchedSourceKind,
        *,
        locator: Optional[str] = None,
        name: Optional[str] = None,
        label: Optional[str] = None,
        intent: Optional[str] = None,
        scope_keys: Optional[list[str]] = None,
        poll_interval_s: Optional[int] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> AddSourceResult:
        """Register something for Kaval to watch.

        A URL is polled conditionally; an ``entity`` (a plain ``name`` plus the ``intent`` you care
        about, e.g. ``add_source("entity", name="Aetna", intent="payer policy bulletins")``) is
        resolved to the URLs that publish it; a ``push`` source is a document you send to
        :meth:`send_event`. Facts learned from a watched source stay warm, so checks on them are a
        database read.
        """
        if locator is None and name is None:
            raise ValueError("add_source requires locator (or name for kind 'entity')")
        body = _clean(
            {
                "kind": kind,
                "locator": locator,
                "name": name,
                "label": label,
                "intent": intent,
                "scope_keys": scope_keys,
                "poll_interval_s": poll_interval_s,
            }
        )
        return cast(
            AddSourceResult,
            self._request(
                "POST",
                "/v1/sources",
                body,
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def list_sources(
        self,
        *,
        include_inactive: bool = False,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> list[WatchedSource]:
        """List this workspace's watched sources, including any auto-discovered by a check."""
        payload = self._request(
            "GET",
            "/v1/sources",
            params={"include_inactive": "true"} if include_inactive else None,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast("list[WatchedSource]", payload["sources"])

    def get_source(
        self,
        source_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> WatchedSource:
        """Fetch one watched source by id."""
        payload = self._request(
            "GET",
            f"/v1/sources/{_path_segment(source_id, name='source_id')}",
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(WatchedSource, payload["source"])

    def delete_source(
        self,
        source_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> dict[str, Any]:
        """Forget a watched source. Returns ``{deleted, id}``."""
        return cast(
            "dict[str, Any]",
            self._request(
                "DELETE",
                f"/v1/sources/{_path_segment(source_id, name='source_id')}",
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def pause_source(
        self,
        source_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> WatchedSource:
        """Stop polling a source without forgetting it or the facts that depend on it."""
        payload = self._request(
            "POST",
            f"/v1/sources/{_path_segment(source_id, name='source_id')}/pause",
            {},
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(WatchedSource, payload["source"])

    def resume_source(
        self,
        source_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> WatchedSource:
        """Resume polling a paused source."""
        payload = self._request(
            "POST",
            f"/v1/sources/{_path_segment(source_id, name='source_id')}/resume",
            {},
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(WatchedSource, payload["source"])

    def recompile_source(
        self,
        source_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> RecompileSourceResult:
        """Re-derive how a source is acquired, when the way it publishes has changed.

        A registered URL is polled with a conditional GET until discovery works out what actually
        publishes it. This queues that discovery again — it is how a directly-registered
        ``kind: "url"`` source gets a plan at all, and the only recovery from a plan that broke
        when the site changed. The 202 body is ``{source_id, job_id, created}``: the job is queued,
        not finished, and ``created`` is False when an open job absorbed this request.
        """
        return cast(
            RecompileSourceResult,
            self._request(
                "POST",
                f"/v1/sources/{_path_segment(source_id, name='source_id')}/recompile",
                {},
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def update_source(
        self,
        source_id: str,
        *,
        extraction_schema_id: Optional[str],
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> WatchedSource:
        """Bind (or, with ``extraction_schema_id=None``, unbind) the extraction schema a source
        runs.

        Every document that lands on this source afterward is extracted against the bound schema
        and delivered as a ``policy_update.document`` webhook. Requires ``policy-update:manage``.
        """
        payload = self._request(
            "PATCH",
            f"/v1/sources/{_path_segment(source_id, name='source_id')}",
            {"extraction_schema_id": extraction_schema_id},
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(WatchedSource, payload["source"])

    def get_source_version_content(
        self,
        source_version_id: str,
        *,
        format: Optional[Literal["sections"]] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> SourceVersionContent | SourceVersionSections:
        """The canonical text Kaval extracted from one source version.

        The same text a ``policy_update.document`` webhook and any bound extraction run were
        computed from. Pass ``format="sections"`` to get it pre-split into heading-bounded
        sections instead of one string.
        """
        return cast(
            "SourceVersionContent | SourceVersionSections",
            self._request(
                "GET",
                f"/v1/source-versions/"
                f"{_path_segment(source_version_id, name='source_version_id')}/content",
                params={"format": format} if format is not None else None,
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    # ------------------------------------------------------------------ policy updates

    def create_extraction_schema(
        self,
        *,
        name: str,
        json_schema: dict[str, Any],
        idempotency_key: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> ExtractionSchema:
        """Register a JSON Schema Kaval extracts structured records against.

        Bind the returned schema's ``id`` to a source with :meth:`update_source`, or pass it
        directly to :meth:`create_policy_update` for a one-off payer + period run. Requires
        ``policy-update:manage``.
        """
        body: CreateExtractionSchemaInput = {"name": name, "json_schema": json_schema}
        payload = self._billable_post(
            "/v1/extraction-schemas",
            cast("dict[str, Any]", body),
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(ExtractionSchema, payload["extraction_schema"])

    def get_extraction_schema(
        self,
        schema_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> ExtractionSchema:
        payload = self._request(
            "GET",
            f"/v1/extraction-schemas/{_path_segment(schema_id, name='schema_id')}",
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(ExtractionSchema, payload["extraction_schema"])

    def list_extraction_schemas(
        self,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> list[ExtractionSchema]:
        payload = self._request(
            "GET",
            "/v1/extraction-schemas",
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast("list[ExtractionSchema]", payload["extraction_schemas"])

    def create_policy_update(
        self,
        *,
        payer_id: str,
        period: str,
        extraction_schema_id: str,
        idempotency_key: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> ExtractionRun:
        """Request a payer + period extraction run against a bound schema.

        The one-off counterpart to letting a source's bound schema run automatically as documents
        land. Requires ``policy-update:manage``. Answers 202 with the run in ``processing``; poll
        :meth:`get_policy_update` or wait for its ``policy_update.document`` webhook.
        """
        body: CreatePolicyUpdateInput = {
            "payer_id": payer_id,
            "period": period,
            "extraction_schema_id": extraction_schema_id,
        }
        payload = self._billable_post(
            "/v1/policy-updates",
            cast("dict[str, Any]", body),
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(ExtractionRun, payload["extraction_run"])

    def get_policy_update(
        self,
        run_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> ExtractionRun:
        payload = self._request(
            "GET",
            f"/v1/policy-updates/{_path_segment(run_id, name='run_id')}",
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(ExtractionRun, payload["extraction_run"])

    def list_policy_updates(
        self,
        *,
        payer_id: Optional[str] = None,
        period: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> list[ExtractionRun]:
        payload = self._request(
            "GET",
            "/v1/policy-updates",
            params=_clean({"payer_id": payer_id, "period": period}),
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast("list[ExtractionRun]", payload["extraction_runs"])

    def get_policy_update_package(
        self,
        package_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> PolicyUpdatePackage:
        payload = self._request(
            "GET",
            f"/v1/policy-update-packages/{_path_segment(package_id, name='package_id')}",
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast(PolicyUpdatePackage, payload["package"])

    def list_policy_update_packages(
        self,
        *,
        payer_id: Optional[str] = None,
        period: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> list[PolicyUpdatePackage]:
        payload = self._request(
            "GET",
            "/v1/policy-update-packages",
            params=_clean({"payer_id": payer_id, "period": period}),
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast("list[PolicyUpdatePackage]", payload["packages"])

    # ------------------------------------------------------------------ events

    def send_event(
        self,
        *,
        source_id: Optional[str] = None,
        namespace: Optional[str] = None,
        document_id: Optional[str] = None,
        content: Optional[str] = None,
        content_url: Optional[str] = None,
        content_sha256: Optional[str] = None,
        observed_at: Optional[str] = None,
        scope_keys: Optional[list[str]] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> SourceEventResult:
        """Push a document you own.

        Kaval stores the version, diffs it against the previous one, marks the dependent facts
        stale, re-evaluates them in the background, and delivers a ``fact_state.delta`` webhook
        naming what flipped. Address the document by ``source_id``, or by ``namespace`` +
        ``document_id`` (created on first sight). ``content`` is extracted text — raw PDF bytes
        are not accepted.
        """
        body = _clean(
            {
                "source_id": source_id,
                "namespace": namespace,
                "document_id": document_id,
                "content": content,
                "content_url": content_url,
                "content_sha256": content_sha256,
                "observed_at": observed_at,
                "scope_keys": scope_keys,
            }
        )
        return cast(
            SourceEventResult,
            self._request(
                "POST",
                "/v1/events",
                body,
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    # ------------------------------------------------------------------ webhooks

    def subscribe_fact_state_deltas(
        self,
        callback_url: str,
        *,
        description: Optional[str] = None,
        external_scope_ids: Optional[list[str]] = None,
        enabled: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> CreateWebhookResult:
        """Subscribe to ``fact_state.delta`` — the outbound half of the whole mechanism.

        Without a subscription the background loops still keep fact state fresh, but nothing tells
        you a fact flipped until your next :meth:`check`. ``external_scope_ids`` filters
        deliveries to the scope keys you care about. The returned ``webhook_verification`` is the
        only time the signing secret is shown; store it and verify every inbound delivery with it.
        """
        return self.create_webhook(
            subscription_kind="fact_state",
            callback_url=callback_url,
            event_types=[FACT_STATE_DELTA_EVENT_TYPE],
            description=description,
            external_scope_ids=external_scope_ids,
            enabled=enabled,
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )

    def subscribe_policy_updates(
        self,
        callback_url: str,
        *,
        description: Optional[str] = None,
        external_scope_ids: Optional[list[str]] = None,
        enabled: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> CreateWebhookResult:
        """Subscribe to ``policy_update.document`` and ``policy_update.monthly_package``.

        Structured records and monthly PDF rollups pushed as they land, instead of polling
        :meth:`list_policy_updates` for the same information. ``external_scope_ids`` filters
        deliveries to the payer/scope keys you care about. The returned ``webhook_verification``
        is the only time the signing secret is shown; store it and verify every inbound delivery
        with it.
        """
        return self.create_webhook(
            subscription_kind="policy_update",
            callback_url=callback_url,
            event_types=list(POLICY_UPDATE_EVENT_TYPES),
            description=description,
            external_scope_ids=external_scope_ids,
            enabled=enabled,
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )

    def create_webhook(
        self,
        *,
        subscription_kind: WebhookSubscriptionKind,
        callback_url: str,
        event_types: list[str],
        description: Optional[str] = None,
        external_scope_ids: Optional[list[str]] = None,
        enabled: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> CreateWebhookResult:
        """Register any webhook subscription.

        ``POST /v1/webhooks`` REQUIRES an ``Idempotency-Key`` header (it answers HTTP 400
        ``idempotency_key_required`` without one), so this client always sends one — a fresh UUID
        when the caller supplies none. The call is not billable and is never auto-retried.
        """
        if not isinstance(callback_url, str) or not callback_url.startswith("https://"):
            raise ValueError("callback_url must be an https URL")
        body = _clean(
            {
                "subscription_kind": subscription_kind,
                "callback_url": callback_url,
                "event_types": event_types,
                "description": description,
                "external_scope_ids": external_scope_ids,
                "enabled": enabled,
            }
        )
        return cast(
            CreateWebhookResult,
            self._request(
                "POST",
                "/v1/webhooks",
                body,
                headers={"idempotency-key": idempotency_key or str(uuid.uuid4())},
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def list_webhooks(
        self,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> list[WebhookSubscription]:
        """List this workspace's webhook subscriptions."""
        payload = self._request(
            "GET",
            "/v1/webhooks",
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return cast("list[WebhookSubscription]", payload["subscriptions"])

    def set_webhook_enabled(
        self,
        subscription_id: str,
        enabled: bool,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> WebhookSubscription:
        """Pause or resume deliveries without losing the subscription's signing key or history."""
        return cast(
            WebhookSubscription,
            self._request(
                "PATCH",
                f"/v1/webhooks/{_path_segment(subscription_id, name='subscription_id')}",
                {"enabled": enabled},
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def delete_webhook(
        self,
        subscription_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> WebhookSubscription:
        """Delete a webhook subscription."""
        return cast(
            WebhookSubscription,
            self._request(
                "DELETE",
                f"/v1/webhooks/{_path_segment(subscription_id, name='subscription_id')}",
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def replay_webhook_delivery(
        self,
        delivery_id: str,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> dict[str, Any]:
        """Re-deliver one dead-lettered delivery after fixing the receiving endpoint."""
        return cast(
            "dict[str, Any]",
            self._request(
                "POST",
                f"/v1/webhook-deliveries/"
                f"{_path_segment(delivery_id, name='delivery_id')}/replay",
                {},
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    # ------------------------------------------------------------------ outcomes

    def report_outcome(
        self,
        id: str,
        kind: OutcomeKind,
        *,
        note: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> dict[str, Any]:
        """Report what actually happened for a prior check (by ``receipt["id"]``), to calibrate."""
        return cast(
            "dict[str, Any]",
            self._request(
                "POST",
                "/v1/report-outcome",
                _clean({"id": id, "kind": kind, "note": note}),
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    # ------------------------------------------------------------------ pilot alias

    def verify(
        self,
        request: Optional[Mapping[str, Any]] = None,
        *,
        conclusion: Optional[str] = None,
        evidence_refs: Optional[Sequence[EvidenceRef]] = None,
        as_of: Optional[str] = None,
        materiality: Optional[Materiality] = None,
        intended_action: Optional[str] = None,
        reversibility: Optional[ActionReversibility] = None,
        jurisdiction: Optional[str] = None,
        context: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> VerifyResult:
        """Verify one load-bearing conclusion against its evidence references.

        .. deprecated:: 0.6
            Pilot compatibility only — use :meth:`check`. One ``check()`` verifies every fact an
            action depends on and returns ALLOW / REVIEW / BLOCK with a signed receipt. This route
            is kept while the Matey pilot migrates and will be removed once both pilots are on
            ``check()``.

        Pass either a single request mapping (``verify({"conclusion": ..., "evidence_refs":
        [...]})``) or the same fields as keywords — never both. ``evidence_refs`` holds 1-20
        references; each is a plain https URL string, or a strict ``{url, document_id}`` object
        when the document has a stable caller identity (``document_id`` values must be unique).

        Returns ``{status, receipt}``: ``status`` is ``valid`` | ``invalidated`` |
        ``could_not_verify`` and ``receipt`` is the signed proof receipt (``proof_id``,
        ``decision`` ALLOW/BLOCK/REVIEW, ``reason``, ``share_endpoint``, and the full signed
        ``packet``). Expiry lives at ``receipt["packet"]["action_decision"]["expires_at"]``.

        This is the only call that spends an operation key: it sends an ``Idempotency-Key`` and
        retries once after an ambiguous failure. (Every successful ``check()`` is metered too — it
        simply is not replayed.)
        """
        field_kwargs = {
            "conclusion": conclusion,
            "evidence_refs": evidence_refs,
            "as_of": as_of,
            "materiality": materiality,
            "intended_action": intended_action,
            "reversibility": reversibility,
            "jurisdiction": jurisdiction,
            "context": context,
        }
        if request is not None:
            if not isinstance(request, Mapping):
                # verify("a sentence") used to die on request.keys(); say where the text goes.
                raise ValueError(
                    "verify takes a request mapping or keyword fields; pass a plain sentence "
                    "as verify(conclusion=..., evidence_refs=[...])"
                )
            if any(value is not None for value in field_kwargs.values()):
                raise ValueError(
                    "pass the verify request as one mapping or as keyword fields, not both"
                )
            unknown = set(request.keys()) - _VERIFY_REQUEST_FIELDS
            if unknown:
                raise ValueError(
                    "unknown verify request fields: " + ", ".join(sorted(unknown))
                )
            field_kwargs = {
                name: request.get(name) for name in _VERIFY_REQUEST_FIELDS
            }
        if not isinstance(field_kwargs["conclusion"], str) or not field_kwargs[
            "conclusion"
        ].strip():
            raise ValueError("verify requires a non-empty conclusion string")
        body = _clean(
            {
                "conclusion": field_kwargs["conclusion"],
                "evidence_refs": _validated_evidence_refs(
                    field_kwargs["evidence_refs"]
                ),
                "as_of": field_kwargs["as_of"],
                "materiality": field_kwargs["materiality"],
                "intended_action": field_kwargs["intended_action"],
                "reversibility": field_kwargs["reversibility"],
                "jurisdiction": field_kwargs["jurisdiction"],
                "context": field_kwargs["context"],
            }
        )
        payload = self._billable_post(
            "/v1/verify",
            body,
            idempotency_key=idempotency_key,
            timeout=timeout,
            cancellation_token=cancellation_token,
        )
        return _verify_result(payload)

    def health(
        self,
        *,
        timeout: RequestTimeout = None,
        cancellation_token: Optional[KavalCancellationToken] = None,
    ) -> dict[str, Any]:
        """Liveness probe. Goes through the same request path as every other call.

        It used to hit the transport directly, which meant the one method most likely to be aimed
        at an unreachable host was also the one that could not be given a deadline or cancelled.
        """
        return cast(
            "dict[str, Any]",
            self._request(
                "GET",
                "/health",
                timeout=timeout,
                cancellation_token=cancellation_token,
            ),
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "KavalClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
