"""Exact TypedDict models for Kaval's public JSON contracts.

Two families live here: the wire types for the one pipeline (``POST /v1/check``, the watched-source
registry, document push, signed check receipts, and the ``fact_state.delta`` webhook subscriptions
the background loops deliver against), and the proof-protocol tree still returned by the deprecated
``verify()`` pilot alias. Field names match the hosted REST JSON exactly.
"""

from __future__ import annotations

from typing import Any, Literal, TypeAlias
from typing_extensions import NotRequired, TypedDict

IsoTimestamp: TypeAlias = str
ContentDigest: TypeAlias = str
ScalarValue: TypeAlias = str | int | float | bool | None
Materiality: TypeAlias = Literal["low", "medium", "high", "critical"]
ActionReversibility: TypeAlias = Literal[
    "reversible", "partially_reversible", "irreversible", "unknown"
]
ActionDisposition: TypeAlias = Literal["ALLOW", "BLOCK", "REVIEW"]
SystemState: TypeAlias = Literal["complete", "degraded", "source_unavailable"]


class RecordRef(TypedDict):
    system: str
    id: str
    table: NotRequired[str]


class ActionContext(TypedDict):
    description: str
    materiality: Materiality
    reversibility: ActionReversibility
    false_allow_cost_usd: NotRequired[float]
    false_block_cost_usd: NotRequired[float]
    wait_cost_usd: NotRequired[float]


class DecisionThreshold(TypedDict):
    policy_id: str
    policy_version: str
    materiality: Materiality
    maximum_false_allow_risk: float
    minimum_evidence_coverage: float


class HumanActionOverride(TypedDict):
    override_id: str
    review_case_id: str
    action_key: str
    action_context_sha256: str
    approved_by: str
    reason: str
    original_decision: ActionDisposition
    created_at: IsoTimestamp
    expires_at: IsoTimestamp


class CalibratedRisk(TypedDict):
    kind: Literal["calibrated"]
    point_estimate: float
    upper_bound: float
    calibration_version: str
    confidence_level: float


class UnavailableRisk(TypedDict):
    kind: Literal["unavailable"]
    reason: str
    evidence_strength: Literal["weak", "moderate", "strong", "decisive"]


RiskEstimate: TypeAlias = CalibratedRisk | UnavailableRisk


class ActionDecision(TypedDict):
    action_decision_id: str
    proof_id: str
    decision: ActionDisposition
    system_state: SystemState
    material_claim_ids: list[str]
    risk: RiskEstimate
    threshold: DecisionThreshold
    reason_codes: list[str]
    summary: str
    unresolved_gap_ids: list[str]
    human_override: NotRequired[HumanActionOverride]
    decided_at: IsoTimestamp
    expires_at: IsoTimestamp


class EntityRef(TypedDict):
    name: str
    id: NotRequired[str]
    type: NotRequired[str]


TemporalInterval = TypedDict(
    "TemporalInterval",
    {"from": NotRequired[IsoTimestamp], "to": NotRequired[IsoTimestamp]},
)


CanonicalClaimType: TypeAlias = Literal[
    "identity",
    "relationship",
    "numeric",
    "temporal",
    "quote",
    "existence",
    "policy",
    "legal",
    "scientific",
    "causal",
    "comparison",
    "media_authenticity",
    "generic",
]
ClaimModality: TypeAlias = Literal[
    "asserted",
    "scheduled",
    "forecast",
    "conditional",
    "opinion",
    "alleged",
    "estimated",
]


class CanonicalClaim(TypedDict):
    id: str
    text: str
    subject: EntityRef
    predicate: str
    object: NotRequired[EntityRef | ScalarValue]
    claim_type: CanonicalClaimType
    negated: bool
    modality: ClaimModality
    as_of: IsoTimestamp
    valid_time: NotRequired[TemporalInterval]
    jurisdiction: NotRequired[str]
    geography: NotRequired[str]
    units: NotRequired[str]
    denominator: NotRequired[str]
    definition: NotRequired[str]
    materiality: Materiality
    dependencies: list[str]


class ClaimDependency(TypedDict):
    claim_id: str
    depends_on_claim_id: str
    requirement: Literal["required", "supporting"]
    rationale: NotRequired[str]


class ClaimDag(TypedDict):
    schema_version: str
    claims: list[CanonicalClaim]
    roots: list[str]
    dependency_edges: list[ClaimDependency]


SourceClass: TypeAlias = Literal[
    "system_of_record",
    "regulator",
    "official_registry",
    "filing",
    "audited_report",
    "primary_document",
    "first_party",
    "peer_reviewed",
    "dataset",
    "archive",
    "expert_analysis",
    "reputable_secondary",
    "aggregator",
    "user_supplied",
    "web",
]
ArtifactKind: TypeAlias = Literal[
    "html",
    "json",
    "xml",
    "pdf",
    "text",
    "database_row",
    "api_response",
    "image",
    "audio",
    "video",
    "other",
]
LegacyAuthority: TypeAlias = Literal["primary", "secondary", "aggregator"]
SourceProximity: TypeAlias = Literal[
    "direct_record",
    "direct_measurement",
    "participant",
    "primary_analysis",
    "secondary_analysis",
    "hearsay",
]


class ProofAdmissibility(TypedDict):
    allowed_source_classes: list[SourceClass]
    forbidden_source_classes: list[SourceClass]
    allowed_artifact_kinds: list[ArtifactKind]
    required_structured_fields: list[str]
    require_raw_artifact: bool
    allow_user_supplied_as_decisive: bool


class ProofAuthorityRule(TypedDict):
    minimum_legacy_authority: LegacyAuthority
    minimum_proximity: SourceProximity
    must_include_any_source_class: list[SourceClass]
    require_authenticity: bool
    require_claim_specific_fitness: bool
    claim_specific_rule: str


class IndependenceRule(TypedDict):
    minimum_evidence_families: int
    minimum_publishers: int
    maximum_members_per_family_counted: int
    require_lineage_resolution: bool
    require_source_family_removal_test: bool
    maximum_family_removal_delta: float


class TemporalProofRule(TypedDict):
    maximum_evidence_age_s: int
    require_valid_time_overlap: bool
    require_published_by_as_of: bool
    require_known_by_as_of: bool
    allow_future_effective_evidence: bool
    future_effective_grace_s: int
    archive_requirement: Literal["never", "when_historical", "always"]


ChallengeStrategy: TypeAlias = Literal[
    "explicit_counter_hypothesis",
    "negated_search",
    "current_holder_search",
    "primary_source_recovery",
    "correction_retraction_search",
    "source_family_removal",
    "evidence_order_perturbation",
    "adversarial_near_miss",
]


class ChallengeRule(TypedDict):
    required: bool
    strategies: list[ChallengeStrategy]
    minimum_counterevidence_queries: int
    require_strongest_opposing_interpretation: bool
    require_stopping_reason: bool


InvalidationTrigger: TypeAlias = Literal[
    "source_changed",
    "source_retracted",
    "source_unavailable",
    "newer_authoritative_evidence",
    "entity_resolution_changed",
    "policy_changed",
    "calibration_changed",
    "valid_time_boundary",
    "manual_correction",
]


class PolicyExpiryRule(TypedDict):
    ttl_s: int
    recheck_before_expiry_s: int
    invalidation_triggers: list[InvalidationTrigger]


class ActionThreshold(TypedDict):
    materiality: Materiality
    maximum_false_allow_risk: float
    minimum_evidence_coverage: float
    minimum_support_probability: float
    on_uncalibrated: Literal["BLOCK", "REVIEW"]
    on_degraded: Literal["BLOCK", "REVIEW"]


class ProofPolicy(TypedDict):
    policy_id: str
    version: str
    effective_from: IsoTimestamp
    superseded_at: NotRequired[IsoTimestamp]
    claim_types: list[CanonicalClaimType]
    semantics: Literal["open_world", "closed_world"]
    admissibility: ProofAdmissibility
    authority: ProofAuthorityRule
    independence: IndependenceRule
    temporal: TemporalProofRule
    challenge: ChallengeRule
    conflict_resolution: list[str]
    force_review_conditions: list[str]
    expiry: PolicyExpiryRule
    action_thresholds: list[ActionThreshold]


class ArtifactEncryption(TypedDict):
    scheme: str
    key_reference: str


class RawArtifactMetadata(TypedDict):
    artifact_id: str
    storage_ref: str
    kind: ArtifactKind
    media_type: str
    byte_length: int
    content_hash: ContentDigest
    captured_at: IsoTimestamp
    compression: Literal["none", "gzip", "br", "zstd", "other"]
    encryption: NotRequired[ArtifactEncryption]
    redaction_state: Literal["none", "metadata_only", "redacted", "sealed"]


class HttpArtifactMetadata(TypedDict):
    status: int
    etag: NotRequired[str]
    last_modified: NotRequired[str]
    content_type: NotRequired[str]
    requested_url: NotRequired[str]
    final_url: NotRequired[str]


class SourceVersion(TypedDict):
    source_version_id: str
    source_id: str
    source_signature: str
    source_class: SourceClass
    legacy_authority: LegacyAuthority
    canonical_url: NotRequired[str]
    raw_artifact: RawArtifactMetadata
    http: NotRequired[HttpArtifactMetadata]
    version_state: Literal[
        "active", "superseded", "corrected", "retracted", "unavailable"
    ]
    published_at: NotRequired[IsoTimestamp]
    modified_at: NotRequired[IsoTimestamp]
    observed_at: IsoTimestamp
    known_at: NotRequired[IsoTimestamp]
    valid_time: NotRequired[TemporalInterval]
    publisher_id: NotRequired[str]
    author_id: NotRequired[str]
    owner_id: NotRequired[str]
    discovery_providers: list[str]
    acquisition_activity_id: str
    supersedes_source_version_id: NotRequired[str]
    correction_notice_source_version_id: NotRequired[str]


class TextLocator(TypedDict):
    kind: Literal["text_offsets"]
    start: int
    end: int


class JsonLocator(TypedDict):
    kind: Literal["json_pointer"]
    pointer: str


class HtmlLocator(TypedDict):
    kind: Literal["html_selector"]
    selector: str
    text_start: NotRequired[int]
    text_end: NotRequired[int]


class PdfLocator(TypedDict):
    kind: Literal["pdf_region"]
    page: int
    bounding_box: list[float]


class TableLocator(TypedDict):
    kind: Literal["table_cell"]
    table: str
    row: str | int
    column: str | int


class RecordLocator(TypedDict):
    kind: Literal["record_field"]
    system: str
    table: str
    record_id: str
    field: str


class MediaLocator(TypedDict):
    kind: Literal["media_time"]
    start_ms: int
    end_ms: int


EvidenceLocator: TypeAlias = (
    TextLocator
    | JsonLocator
    | HtmlLocator
    | PdfLocator
    | TableLocator
    | RecordLocator
    | MediaLocator
)


class EvidenceSpan(TypedDict):
    evidence_span_id: str
    source_version_id: str
    locator: EvidenceLocator
    quote: NotRequired[str]
    structured_value: NotRequired[ScalarValue]
    span_hash: ContentDigest
    language: NotRequired[str]
    extracted_at: IsoTimestamp
    visibility: Literal["public", "tenant_private", "restricted"]
    quarantined: bool
    injection_detected: bool


class LineageEdge(TypedDict):
    lineage_edge_id: str
    from_source_version_id: str
    to_source_version_id: str
    relationship: Literal[
        "derived_from",
        "copied_from",
        "syndicated_from",
        "quotes",
        "cites",
        "updates",
        "supersedes",
        "corrects",
        "retracts",
    ]
    confidence: float
    explicit_attribution: bool
    evidence_span_ids: list[str]


class EvidenceFamily(TypedDict):
    evidence_family_id: str
    label: str
    member_source_version_ids: list[str]
    origin_source_version_ids: list[str]
    lineage_edge_ids: list[str]
    methods: list[
        Literal[
            "explicit_attribution",
            "exact_text",
            "near_duplicate",
            "shared_origin",
            "publisher_ownership",
            "manual",
        ]
    ]
    publisher_group_id: NotRequired[str]
    upstream_dataset_id: NotRequired[str]
    confidence: float
    independence_rationale: str


class StanceProbabilities(TypedDict):
    support: float
    refute: float
    neutral: float


class EntityFit(TypedDict):
    state: Literal["match", "partial", "mismatch", "unknown"]
    score: float
    rationale: str


class ScopeFit(TypedDict):
    state: Literal["exact", "partial", "mismatch", "unknown"]
    score: float
    rationale: str


class TemporalFit(TypedDict):
    state: Literal["applicable", "partial", "inapplicable", "unknown"]
    score: float
    rationale: str


class EvidenceAssessment(TypedDict):
    evidence_assessment_id: str
    claim_id: str
    evidence_span_id: str
    evidence_family_id: str
    stance: StanceProbabilities
    entity_match: EntityFit
    scope_fit: ScopeFit
    temporal_fit: TemporalFit
    extraction_confidence: float
    source_fitness: float
    support_mode: Literal["direct", "inferential"]
    admissible: bool
    exclusion_reason: NotRequired[str]


AssessmentGapKind: TypeAlias = Literal[
    "missing_authority",
    "missing_independence",
    "missing_counterevidence_search",
    "entity_ambiguity",
    "scope_mismatch",
    "temporal_ambiguity",
    "source_unavailable",
    "conflict_unresolved",
    "calibration_unavailable",
    "policy_incomplete",
    "other",
]


class AssessmentGap(TypedDict):
    gap_id: str
    kind: AssessmentGapKind
    severity: Literal["informational", "material", "blocking"]
    description: str
    resolvable: bool
    required_evidence: list[str]


class CalibratedSupport(TypedDict):
    probability: float
    calibration_version: str


class CalibrationSupportIdentity(TypedDict):
    """Exact server-derived cohort identity used to issue this claim assessment."""

    feature_schema_version: str
    feature_schema_hash: ContentDigest
    support_fingerprint: ContentDigest
    feature_vector: dict[str, Any]


class ClaimAssessment(TypedDict):
    claim_assessment_id: str
    claim_id: str
    claim_state: Literal["supported", "refuted", "mixed", "unresolved", "unverifiable"]
    temporal_state: Literal["current", "superseded", "future", "expired", "unknown"]
    system_state: SystemState
    stance: StanceProbabilities
    evidence_coverage: float
    calibrated_support: NotRequired[CalibratedSupport]
    calibration_support: CalibrationSupportIdentity
    risk_upper_bound: NotRequired[float]
    evidence_assessments: list[EvidenceAssessment]
    decisive_evidence_span_ids: list[str]
    counterevidence_span_ids: list[str]
    unresolved_gaps: list[AssessmentGap]
    what_would_change_this: list[str]
    assessed_at: IsoTimestamp


class ProtocolManifest(TypedDict):
    protocol: Literal["kaval-proof"]
    protocol_version: str
    schema_version: str
    compiler_version: str
    planner_version: str
    adjudicator_version: str
    model_versions: dict[str, str]
    tool_versions: dict[str, str]
    parser_versions: dict[str, str]


class PolicyBinding(TypedDict):
    claim_id: str
    policy_id: str
    policy_version: str
    policy_hash: ContentDigest


class CalibrationMetrics(TypedDict):
    brier_score: float
    log_loss: float
    expected_calibration_error: float
    sample_size: int


class AvailableCalibration(TypedDict):
    status: Literal["calibrated"]
    version: str
    protocol_version: str
    training_dataset_hash: ContentDigest
    evaluation_dataset_hash: ContentDigest
    feature_schema_version: str
    feature_schema_hash: ContentDigest
    method: str
    trained_through: IsoTimestamp
    applicable_claim_types: list[str]
    applicable_domains: list[str]
    metrics: CalibrationMetrics


class WithheldCalibration(TypedDict):
    status: Literal["withheld"]
    reason: str
    evidence_strength_scale_version: str


CalibrationManifest: TypeAlias = AvailableCalibration | WithheldCalibration
ProvenanceActivityKind: TypeAlias = Literal[
    "compile",
    "plan",
    "search",
    "fetch",
    "render",
    "parse",
    "extract",
    "entity_resolve",
    "lineage_cluster",
    "adjudicate",
    "challenge",
    "calibrate",
    "decide",
]


class ProvenanceActivity(TypedDict):
    activity_id: str
    kind: ProvenanceActivityKind
    parent_activity_ids: list[str]
    status: Literal["completed", "failed", "cancelled", "timed_out"]
    provider: NotRequired[str]
    tool_version: NotRequired[str]
    model_version: NotRequired[str]
    parser_version: NotRequired[str]
    parameters_hash: ContentDigest
    input_hashes: list[ContentDigest]
    output_hashes: list[ContentDigest]
    started_at: IsoTimestamp
    completed_at: IsoTimestamp
    error_code: NotRequired[str]


class ResearchContract(TypedDict):
    held_belief: str
    as_of: IsoTimestamp
    action: ActionContext
    domain: NotRequired[str]
    subject_hint: NotRequired[str]
    jurisdiction: NotRequired[str]
    geography: NotRequired[str]
    units: NotRequired[str]


class ProofProvenance(TypedDict):
    activities: list[ProvenanceActivity]
    root_activity_ids: list[str]
    research_stopping_reason: str


class ProofExpiry(TypedDict):
    issued_at: IsoTimestamp
    expires_at: IsoTimestamp
    recheck_at: IsoTimestamp
    invalidation_triggers: list[InvalidationTrigger]
    monitor_id: NotRequired[str]


class PacketSignature(TypedDict):
    algorithm: Literal["Ed25519", "HMAC-SHA256"]
    key_id: str
    signature: str


class ProofPacket(TypedDict):
    proof_id: str
    created_at: IsoTimestamp
    research_contract: ResearchContract
    protocol: ProtocolManifest
    claim_dag: ClaimDag
    policies: list[ProofPolicy]
    policy_bindings: list[PolicyBinding]
    source_versions: list[SourceVersion]
    evidence_spans: list[EvidenceSpan]
    evidence_families: list[EvidenceFamily]
    lineage_edges: list[LineageEdge]
    claim_assessments: list[ClaimAssessment]
    action_decision: ActionDecision
    calibration: CalibrationManifest
    provenance: ProofProvenance
    expiry: ProofExpiry
    signature: NotRequired[PacketSignature]


# ---------------------------------------------------------------------------
# POST /v1/check — the one call. Everything below configures what it reads from.
# ---------------------------------------------------------------------------


#: The verdict an agent branches on. Only ALLOW means "safe to act".
CheckVerdict: TypeAlias = Literal["ALLOW", "REVIEW", "BLOCK"]

#: The complete reason-code taxonomy — eight codes, no synonyms, no free text.
CheckReasonCode: TypeAlias = Literal[
    "ALL_FACTS_HOLD",
    "FACT_CHANGED",
    "FACT_EXPIRED",
    "FACT_UNKNOWN",
    "SOURCE_UPDATED_PENDING_REVIEW",
    "SOURCE_UNREACHABLE",
    "NEW_FACT_UNVERIFIED",
    "COMPILATION_UNCERTAIN",
]

#: The public three-valued projection of a fact's internal assessment.
FactStatus: TypeAlias = Literal["holds", "changed", "unknown"]

#: ``fast`` skips the live fallback entirely and answers from stored fact state only.
CheckMode: TypeAlias = Literal["fast", "standard"]


class StructuredClaim(TypedDict):
    """A claim already decomposed by the caller.

    Structured claims are the zero-LLM path: they canonicalize straight to a fact fingerprint, so
    the warm lookup needs no model call.
    """

    subject: str | EntityRef
    predicate: str
    object: NotRequired[str | EntityRef | ScalarValue]
    scope: NotRequired[dict[str, str]]
    materiality: NotRequired[Materiality]
    #: Optional human rendering; defaults to a deterministic render of the structure.
    text: NotRequired[str]


ClaimInput: TypeAlias = str | StructuredClaim


class CheckInput(TypedDict):
    """``POST /v1/check`` body. Provide at least one of ``action`` or ``claims``."""

    #: What the agent is about to do, in plain language. Kaval compiles the facts it depends on.
    action: NotRequired[str]
    #: Anything the agent already knows that bears on the action.
    context: NotRequired[str]
    #: Facts to check directly, as plain sentences or structured claims (max 20).
    claims: NotRequired[list[ClaimInput]]
    mode: NotRequired[CheckMode]
    #: Live-path budget in ms (default 100000, max 100000; 0 disables research, which is what
    #: ``mode: "fast"`` sets). Facts that miss it enter as ``unknown``. The budget exists so a
    #: caller at an action boundary can ask for LESS waiting — never more.
    max_wait_ms: NotRequired[int]
    #: Caller-declared origins, merged with the workspace's registered watched sources.
    origin_urls: NotRequired[list[str]]
    materiality: NotRequired[Materiality]
    as_of: NotRequired[IsoTimestamp]


class CheckSourceRef(TypedDict):
    locator: str
    version_sha256: NotRequired[str]
    fetched_at: NotRequired[IsoTimestamp]


class CheckFact(TypedDict):
    fingerprint: str
    text: str
    status: FactStatus
    materiality: Materiality
    #: True when the answer came from warm fact state instead of live research.
    served_from_state: bool
    last_verified_at: str | None
    sources: list[CheckSourceRef]


class CheckLatency(TypedDict):
    compile: float
    lookup: float
    live: float
    total: float


class CheckReceiptRef(TypedDict):
    id: str
    signature: str
    signed_at: IsoTimestamp


class CheckResult(TypedDict):
    """``POST /v1/check`` response. ``receipt["id"]`` fetches the signed document via
    ``get_receipt()``."""

    decision: CheckVerdict
    reason_codes: list[CheckReasonCode]
    facts: list[CheckFact]
    receipt: CheckReceiptRef
    latency_ms: CheckLatency


# --------------------------------- receipts ---------------------------------

#: Why a stored fact state could not be served; published so the verdict re-derives offline.
CheckFreshnessFailure: TypeAlias = Literal[
    "stale",
    "dormant",
    "basis_superseded",
    "source_unreachable",
    "ttl_expired",
]


class CheckReceiptBasis(TypedDict):
    source_locator: str
    #: Digest of the version this fact was proved against. ABSENT when nothing was pinned.
    version_sha256: NotRequired[str]
    #: What ``version_sha256`` covers. A PDF's canonical text is extracted markdown, so the same
    #: document has two unequal legitimate digests; unlabelled, a holder cannot know which artifact
    #: to hash and the field is decorative. Always present when ``version_sha256`` is.
    version_sha256_of: NotRequired[Literal["canonical_text", "raw_bytes"]]
    #: The extractor that produced the canonical text, when one did. Absent for a plain HTTP body.
    parser_name: NotRequired[str]
    parser_version: NotRequired[str]
    fetched_at: NotRequired[IsoTimestamp]
    publication_time: NotRequired[IsoTimestamp]
    span_ref: NotRequired[Any]


class CheckReceiptFact(TypedDict):
    fingerprint: str
    text: str
    materiality: Materiality
    state: FactStatus
    checked_at: IsoTimestamp
    method: Literal["state", "live", "timeout"]
    temporal_state: str | None
    stale_pending: bool
    novel: bool
    freshness_failure: CheckFreshnessFailure | None
    basis: list[CheckReceiptBasis]


class CheckReceiptSignature(TypedDict):
    algorithm: str
    key_id: str
    signature: str
    signed_at: IsoTimestamp


class CheckReceipt(TypedDict):
    """The receipt EXACTLY as signed.

    The decision table is published, so this fact list re-derives the verdict offline — verify
    ``signature`` with the issuer's Ed25519 public key.
    """

    receipt_version: str
    id: str
    tenant_id: str
    workspace_id: str | None
    decision: CheckVerdict
    reason_codes: list[CheckReasonCode]
    decision_rule_version: str
    mode: CheckMode
    checked_at: IsoTimestamp
    compilation_uncertain: bool
    facts: list[CheckReceiptFact]
    proof_packet_ids: list[str]
    signature: CheckReceiptSignature


# ---------------------------------- sources ---------------------------------

#: ``entity`` resolves a plain name ("Aetna") to the URLs that publish it and watches those;
#: ``push`` is a document the customer POSTs to ``/v1/events``; ``discovered`` is auto-registered
#: when a check cites a URL nobody registered.
WatchedSourceKind: TypeAlias = Literal[
    "url",
    "push",
    "connection",
    "entity",
    "discovered",
]
WatchedSourceOrigin: TypeAlias = Literal["registered", "discovered", "resolved"]


class WatchedSource(TypedDict):
    id: str
    kind: WatchedSourceKind
    locator: str
    #: Always present and usually null — most sources are registered without one. Typed nullable
    #: rather than optional so ``source["label"].upper()`` is the type error it really is instead
    #: of an AttributeError on the common case.
    label: str | None
    intent: str | None
    origin: WatchedSourceOrigin
    parent_source_id: str | None
    scope_keys: list[str]
    active: bool
    poll_interval_s: int | None
    next_poll_at: str | None
    last_success_at: str | None
    content_sha256: str | None
    #: Org publisher UUID bound at register / ``update_source``.
    publisher_id: NotRequired[str | None]
    #: Inherited publisher when this is a discovered child.
    resolved_publisher_id: NotRequired[str | None]
    #: The ``ExtractionSchema`` id bound with ``update_source()``, or ``None`` if this source runs
    #: unbound.
    extraction_schema_id: NotRequired[str | None]
    created_at: IsoTimestamp


class UpdateSourceResult(WatchedSource):
    """``PATCH /v1/sources/:id`` result.

    Same watched source as :meth:`kaval.client.KavalClient.update_source` has always returned,
    plus ``reprocess_queued`` when ``reprocess=True`` was accepted.
    """

    reprocess_queued: NotRequired[int]


class AddSourceInput(TypedDict):
    kind: WatchedSourceKind
    #: Org publisher UUID from :meth:`list_publishers` / :meth:`create_publisher` — required.
    publisher_id: str
    #: The URL, connection id, or push locator. For ``kind: "entity"`` use ``name`` instead.
    locator: NotRequired[str]
    #: ``kind: "entity"`` reads more naturally as a name — it is the same locator field.
    name: NotRequired[str]
    label: NotRequired[str]
    #: What you want watched about it, e.g. "payer policy bulletins". Drives entity resolution.
    intent: NotRequired[str]
    #: Scope tags used to route document pushes to the facts they can affect.
    scope_keys: NotRequired[list[str]]
    poll_interval_s: NotRequired[int]


class AddSourceResult(TypedDict):
    source: WatchedSource
    created: bool
    #: Sources an ``entity`` registration resolved to and is now watching.
    resolved: list[WatchedSource]
    resolution_error: NotRequired[str]


class RecompileSourceResult(TypedDict):
    """``POST /v1/sources/:id/recompile`` — 202, the job is queued, not done."""

    source_id: str
    job_id: str
    #: False when a job was already open for this source: the recompile was folded into that one
    #: rather than duplicated.
    created: bool


# ------------------------------- extraction runs ------------------------------
#
# The Luminai loop: bind an ``ExtractionSchema`` to a watched source (or a whole publisher), let
# Kaval extract structured records from what it reads, and get ``extraction.*`` webhooks as
# documents land — instead of polling ``list_bulletins()`` for the same information. The product
# still calls these Updates.


class ExtractionSchema(TypedDict):
    """A customer-defined JSON Schema Kaval extracts structured records against."""

    id: str
    workspace_id: str
    name: str
    json_schema: dict[str, Any]
    schema_sha256: str
    created_at: IsoTimestamp


class CreateExtractionSchemaInput(TypedDict):
    name: str
    json_schema: dict[str, Any]


ExtractionRunStatus: TypeAlias = Literal[
    "processing", "retry", "succeeded", "review_required", "failed"
]
ExtractionRunScope: TypeAlias = Literal["document", "payer_period"]


class ExtractionRun(TypedDict):
    """One extraction attempt.

    Either against a single document (``scope: "document"``, the basis of an
    ``extraction.document`` webhook) or a publisher + period rollup (``scope: "payer_period"``,
    created by :meth:`KavalClient.create_extraction_run`). The product still calls this an Update.

    ``period`` is the publication / newsletter month (``YYYY-MM``), not the effective month of an
    individual PA change. ``result`` may include ``records``, ``record_evidence``,
    ``document_period``, ``period_basis``, and ``payer_name``.
    """

    id: str
    workspace_id: str
    scope: ExtractionRunScope
    source_version_id: NotRequired[str]
    #: Org publisher UUID. Prefer ``publisher_name`` (when present) for display.
    publisher_id: NotRequired[str]
    #: Expand-era echo of ``publisher_id`` (same uuid string).
    payer_id: NotRequired[str]
    #: Renameable display label from the org publishers table.
    publisher_name: NotRequired[str]
    #: Publication / newsletter month ``YYYY-MM``.
    period: NotRequired[str]
    extraction_schema_id: str | None
    status: ExtractionRunStatus
    model: NotRequired[str]
    prompt_sha256: NotRequired[str]
    sections: NotRequired[dict[str, Any]]
    result: NotRequired[dict[str, Any]]
    raw_output: NotRequired[str]
    error_code: NotRequired[str]
    attempt_count: int
    created_at: IsoTimestamp
    updated_at: IsoTimestamp
    finished_at: NotRequired[IsoTimestamp]
    reprocess: NotRequired[Literal[True]]
    generation: NotRequired[int]


class CreateExtractionRunInput(TypedDict):
    """Request a publisher + period extraction run. Requires ``policy-update:manage``."""

    publisher_id: str
    #: Publication / newsletter month ``YYYY-MM``.
    period: str
    extraction_schema_id: str


ExtractionPackageStatus: TypeAlias = Literal["ready", "partial"]


class ExtractionPackage(TypedDict):
    """The monthly rollup of every publisher/period extraction into one PDF + manifest."""

    id: str
    workspace_id: str
    publisher_id: str
    #: Expand-era echo of ``publisher_id`` (same uuid string).
    payer_id: NotRequired[str]
    publisher_name: NotRequired[str]
    #: Publication / newsletter month ``YYYY-MM``.
    period: str
    status: ExtractionPackageStatus
    pdf_href: str
    pdf_sha256: NotRequired[str]
    manifest: dict[str, Any]
    built_at: IsoTimestamp


class Publisher(TypedDict):
    """Org-owned publisher. UUID is identity; name is renameable."""

    id: str
    billing_account_id: str
    name: str
    created_at: IsoTimestamp
    updated_at: IsoTimestamp


class CreatePublisherInput(TypedDict):
    name: str


class UpdatePublisherInput(TypedDict):
    name: str


class SourceVersionContent(TypedDict):
    """``GET /v1/source-versions/:id/content`` without ``?format=sections``."""

    content: str


class ExtractionBbox(TypedDict):
    """Normalized [0, 1] bounding box on a PDF page (from Parse layout at ingest)."""

    left: float
    top: float
    width: float
    height: float


class ExtractionDocumentSection(TypedDict):
    """One heading-bounded slice of a source version's canonical markdown."""

    index: int
    heading: str
    start_offset: int
    end_offset: int
    text: NotRequired[str]
    #: 1-indexed page when Parse layout was stored for this version.
    page: NotRequired[int]
    #: Normalized [0, 1] bbox on ``page`` when available.
    bbox: NotRequired[ExtractionBbox]


class ExtractionRecordEvidence(TypedDict):
    """Locates one extracted record in the source PDF via its section + layout."""

    section_index: int
    page: int
    bbox: ExtractionBbox
    block_ids: NotRequired[list[str]]


class ExtractionRecords(TypedDict):
    """Schema-bound payload nested under ``extraction.document`` ``data.extraction``."""

    records: list[Any]
    run_href: str
    #: Parallel to ``records``; empty list when a record has no locatable section.
    record_evidence: NotRequired[list[list[ExtractionRecordEvidence]]]


class SourceVersionSections(TypedDict):
    """``GET /v1/source-versions/:id/content?format=sections``."""

    sections: list[ExtractionDocumentSection]


#: The only two events an ``extraction`` subscription accepts.
EXTRACTION_DOCUMENT_EVENT_TYPE = "extraction.document"
EXTRACTION_PACKAGE_EVENT_TYPE = "extraction.package"
EXTRACTION_EVENT_TYPES = (
    EXTRACTION_DOCUMENT_EVENT_TYPE,
    EXTRACTION_PACKAGE_EVENT_TYPE,
)


class ExtractionDocumentEventData(TypedDict):
    workspace_id: str
    publisher_id: str
    #: Expand-era echo of ``publisher_id`` (same uuid string).
    payer_id: NotRequired[str]
    publisher_name: NotRequired[str]
    source_version_id: str
    #: ``new`` first content version; ``updated`` later version; ``schema_changed`` same PDF
    #: under a newly bound schema. Match ``schema_changed`` on ``source_version_id``.
    source_change: NotRequired[Literal["new", "updated", "schema_changed"]]
    source_id: NotRequired[str]
    generation: NotRequired[int]
    #: Durable Kaval source-version PDF URL — not a short-lived parser studio link.
    pdf_href: str
    content_href: str
    sections: list[ExtractionDocumentSection]
    extraction_run: ExtractionRun
    #: Present when a schema was bound; absent for content-only delivery.
    extraction: NotRequired[ExtractionRecords]


class ExtractionDocumentEvent(TypedDict):
    """The body of an inbound ``extraction.document`` webhook."""

    specversion: Literal["1.0"]
    id: str
    type: Literal["extraction.document"]
    source: str
    subject: str
    time: IsoTimestamp
    correlation_id: str
    sequence: int
    data: ExtractionDocumentEventData


class ExtractionPackageEventData(TypedDict):
    workspace_id: str
    package: ExtractionPackage


class ExtractionPackageEvent(TypedDict):
    """The body of an inbound ``extraction.package`` webhook."""

    specversion: Literal["1.0"]
    id: str
    type: Literal["extraction.package"]
    source: str
    subject: str
    time: IsoTimestamp
    correlation_id: str
    sequence: int
    data: ExtractionPackageEventData


ExtractionWebhookEvent: TypeAlias = ExtractionDocumentEvent | ExtractionPackageEvent


# ----------------------------------- events ---------------------------------


class SourceEventInput(TypedDict):
    """``POST /v1/events`` — the customer-push half of the watch mechanism."""

    #: Address an already-registered source…
    source_id: NotRequired[str]
    #: …or address the document as ``namespace`` + ``document_id`` (created on first sight).
    namespace: NotRequired[str]
    document_id: NotRequired[str]
    #: Extracted text. Raw PDF bytes are not accepted.
    content: NotRequired[str]
    content_url: NotRequired[str]
    content_sha256: NotRequired[str]
    observed_at: NotRequired[IsoTimestamp]
    scope_keys: NotRequired[list[str]]


class SourceEventResult(TypedDict):
    accepted: bool
    #: False for a same-content push: no version row, no staleness, no delta webhook.
    changed: bool
    source_id: str
    version_id: str | None
    content_sha256: str
    previous_content_sha256: str | None
    #: Facts whose basis moved and whose re-evaluation is still running — checks REVIEW meanwhile.
    facts_pending_review: int


# ---------------------------------- webhooks --------------------------------

WebhookSubscriptionKind: TypeAlias = Literal[
    "belief_integrity",
    "monitor",
    "fact_state",
    "extraction",
    "policy_update",
]

#: Kinds accepted on create. Existing ``policy_update`` subscriptions still appear on list.
CreateWebhookSubscriptionKind: TypeAlias = Literal[
    "belief_integrity",
    "monitor",
    "fact_state",
    "extraction",
]

#: The only event a ``fact_state`` subscription accepts.
FACT_STATE_DELTA_EVENT_TYPE = "fact_state.delta"


class CreateWebhookInput(TypedDict):
    subscription_kind: CreateWebhookSubscriptionKind
    #: Must be https.
    callback_url: str
    event_types: list[str]
    description: NotRequired[str]
    #: Deliver only deltas whose scope intersects these ids. Empty means everything.
    external_scope_ids: NotRequired[list[str]]
    enabled: NotRequired[bool]


class WebhookSubscription(TypedDict):
    subscription_id: str
    workspace_id: NotRequired[str]
    subscription_kind: NotRequired[WebhookSubscriptionKind]
    callback_url: NotRequired[str]
    event_types: NotRequired[list[str]]
    external_scope_ids: NotRequired[list[str]]
    enabled: NotRequired[bool]
    signing_key_id: NotRequired[str]


class WebhookVerification(TypedDict):
    """Everything needed to verify an inbound delta's HMAC signature.

    Returned once, at creation — the secret is never shown again.
    """

    algorithm: str
    key_id: str
    secret: str
    signed_content: str
    headers: list[str]


class CreateWebhookResult(TypedDict):
    subscription: WebhookSubscription
    webhook_verification: WebhookVerification


# ------------------------------- delta payload ------------------------------


class FactBasisRef(TypedDict):
    source_locator: str
    version_sha256: NotRequired[str]
    fetched_at: NotRequired[IsoTimestamp]
    publication_time: NotRequired[IsoTimestamp]
    span_ref: NotRequired[Any]


class FactStateTransition(TypedDict):
    fingerprint: str
    text: str
    materiality: Materiality
    old_state: FactStatus | None
    new_state: FactStatus
    basis: list[FactBasisRef]


class FactStateDeltaSource(TypedDict):
    watched_source_id: str
    kind: WatchedSourceKind
    locator: str
    label: NotRequired[str]


class FactStateDeltaReceiptRef(TypedDict):
    proof_packet_id: NotRequired[str]
    receipt_url: NotRequired[str]
    signature: NotRequired[str]


class FactStateDeltaData(TypedDict):
    tenant_id: str
    workspace_id: NotRequired[str | None]
    source: FactStateDeltaSource
    old_version_sha256: str | None
    new_version_sha256: str
    diff_summary: Any
    facts: list[FactStateTransition]
    receipt: NotRequired[FactStateDeltaReceiptRef]
    changed_at: IsoTimestamp


class FactStateDeltaEvent(TypedDict):
    """The body of an inbound ``fact_state.delta`` webhook.

    "Here is what changed and what it flipped" — typed here so a receiver can parse it without
    reimplementing the contract.
    """

    specversion: Literal["1.0"]
    id: str
    type: str
    source: str
    subject: str
    time: IsoTimestamp
    correlation_id: str
    sequence: int
    data: FactStateDeltaData


# ---------------------------------------------------------------------------
# POST /v1/verify — the deprecated pilot alias for single conclusions.
# ---------------------------------------------------------------------------


class EvidenceDocumentRef(TypedDict):
    """An evidence URL bound to a stable caller-owned document identity.

    ``document_id`` is required on the object form; a reference without one must be a plain
    URL string instead. ``document_id`` values must be unique across one request.
    """

    url: str
    document_id: str


EvidenceRef: TypeAlias = str | EvidenceDocumentRef
VerifyStatus: TypeAlias = Literal["valid", "invalidated", "could_not_verify"]


class VerifyInput(TypedDict):
    conclusion: str
    evidence_refs: list[EvidenceRef]
    as_of: NotRequired[IsoTimestamp]
    materiality: NotRequired[Materiality]
    intended_action: NotRequired[str]
    reversibility: NotRequired[ActionReversibility]
    jurisdiction: NotRequired[str]
    context: NotRequired[str]


class VerifyReceipt(TypedDict):
    """The signed proof receipt returned with every verify verdict.

    There is deliberately NO receipt-level ``expires_at``: expiry lives at
    ``packet["action_decision"]["expires_at"]``. ``share_endpoint`` is a follow-up endpoint
    (``/v1/proofs/<id>/share``), not a bearer URL.
    """

    proof_id: str
    decision: ActionDisposition
    reason: str
    share_endpoint: str
    packet: ProofPacket


class VerifyResult(TypedDict):
    status: VerifyStatus
    receipt: VerifyReceipt
