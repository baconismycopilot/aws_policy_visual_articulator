"""Fetch AWS IAM metadata, merge the two upstreams, and shard it for the site.

Two sources, because neither is complete on its own:

  policies.js  AWS's own policy-generator data. Authoritative for ARN formats,
               condition operators, and policy types. Ships no CORS headers, so
               the browser cannot fetch it directly -- hence this build step.
  iam_dataset  A scrape of the Service Authorization Reference. Authoritative
               for per-action access levels, resource types, dependent actions,
               and condition keys.

Output layout (all under site/data/):

  global.json        condition operators, global condition keys, policy types
  index.json         every service: prefix, name, action count  (~6 KB gzipped)
  svc/<prefix>.json  one shard per service                      (~1 KB median)

Usage:
    python -m build.build [--cache] [--out site/data]

    --cache  reuse previously downloaded upstreams from build/.cache/ instead
             of refetching. Speeds up frontend iteration considerably.
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

import httpx
from loguru import logger

from build.models import (
    Action,
    BuildManifest,
    ConditionKey,
    GlobalData,
    IndexEntry,
    ResourceType,
    ResourceTypeRef,
    Service,
)

POLICYGEN_URL = "https://awspolicygen.s3.amazonaws.com/js/policies.js"
SAR_URL = (
    "https://raw.githubusercontent.com/iann0036/iam-dataset"
    "/refs/heads/main/aws/iam_definition.json"
)

ROOT = Path(__file__).parent.parent
CACHE_DIR = Path(__file__).parent / ".cache"
DEFAULT_OUT = ROOT / "site" / "data"

# Commercial first -- it is the default in every ARN the UI builds.
PARTITIONS = ["aws", "aws-cn", "aws-us-gov"]


def _fetch(url: str, cache_name: str, use_cache: bool) -> tuple[str, str | None]:
    """Return (body, etag), reading from build/.cache/ when use_cache is set."""
    cached = CACHE_DIR / cache_name

    if use_cache and cached.exists():
        logger.info(f"Using cached {cache_name}")
        return cached.read_text(), None

    logger.info(f"Fetching {url}")
    resp = httpx.get(url, timeout=120, follow_redirects=True)
    resp.raise_for_status()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached.write_text(resp.text)

    return resp.text, resp.headers.get("ETag")


def parse_policygen(body: str) -> dict:
    """Extract the JSON payload from ``app.PolicyEditorConfig={...}``.

    Slicing from the first brace rather than splitting on ``=`` -- the payload
    contains ARN templates full of ``=`` characters.
    """
    start = body.index("{")
    return json.loads(body[start:])


def _access_levels(raw: str) -> list[str]:
    """Split the upstream access level string into its parts.

    The SAR encodes multiple levels as one comma-joined string, e.g.
    ``"Permissions management, Write"``.
    """
    levels = [part.strip() for part in (raw or "").split(",") if part.strip()]
    return levels or ["Unknown"]


def _resource_type_ref(raw: dict) -> ResourceTypeRef:
    """Build a ResourceTypeRef from a SAR ``resource_types`` entry.

    The Service Authorization Reference marks a required resource type with a
    trailing asterisk (``object*``); an empty name means the action can be used
    with ``Resource: "*"``.
    """
    name = raw.get("resource_type", "")

    return ResourceTypeRef(
        resource_type=name.rstrip("*"),
        required=name.endswith("*"),
        condition_keys=raw.get("condition_keys", []),
        dependent_actions=raw.get("dependent_actions", []),
    )


def merge(policygen: dict, sar: list[dict]) -> tuple[dict[str, Service], BuildManifest]:
    """Union the two sources by service prefix.

    A union, not an intersection: policies.js carries ~473 services and the SAR
    scrape ~418, and each has entries the other lacks. Taking only the overlap
    (as the original app did) silently drops dozens of services.
    """
    services: dict[str, Service] = {}

    # SAR first -- it has the richer per-action detail.
    sar_prefixes: set[str] = set()
    for entry in sar:
        prefix = entry.get("prefix", "")
        if not prefix:
            continue
        sar_prefixes.add(prefix)

        actions = [
            Action(
                name=p["privilege"],
                access_levels=_access_levels(p.get("access_level", "")),
                description=p.get("description", ""),
                resource_types=[
                    _resource_type_ref(rt) for rt in p.get("resource_types", [])
                ],
            )
            for p in entry.get("privileges", [])
        ]

        if prefix in services:
            # Duplicate prefix in the SAR data -- merge action lists.
            logger.warning(f"Duplicate SAR prefix {prefix!r}, merging actions")
            known = {a.name for a in services[prefix].actions}
            services[prefix].actions.extend(a for a in actions if a.name not in known)
            continue

        services[prefix] = Service(
            prefix=prefix,
            service_name=entry.get("service_name", prefix),
            actions=actions,
            resources=[
                ResourceType(
                    resource=r.get("resource", ""),
                    arn=r.get("arn", ""),
                    condition_keys=r.get("condition_keys", []),
                )
                for r in entry.get("resources", [])
            ],
            conditions=[
                ConditionKey(
                    condition=c.get("condition", ""),
                    description=c.get("description", ""),
                    type=c.get("type", "String"),
                )
                for c in entry.get("conditions", [])
            ],
        )

    # Layer policies.js on top for ARN metadata and any services SAR missed.
    policygen_prefixes: set[str] = set()
    for name, detail in policygen.get("serviceMap", {}).items():
        prefix = detail.get("StringPrefix", "")
        if not prefix:
            continue
        policygen_prefixes.add(prefix)

        svc = services.get(prefix)
        if svc is None:
            # Known to the policy generator but absent from the SAR scrape.
            svc = Service(prefix=prefix, service_name=name)
            services[prefix] = svc

        svc.arn_format = detail.get("ARNFormat", "") or svc.arn_format
        svc.arn_regex = detail.get("ARNRegex", "") or svc.arn_regex
        svc.has_resource = bool(detail.get("HasResource", False)) or svc.has_resource
        svc.service_condition_keys = sorted(
            set(svc.service_condition_keys) | set(detail.get("conditionKeys", []))
        )

        # Fill in actions policies.js knows about but SAR does not.
        known = {a.name for a in svc.actions}
        for action_name in detail.get("Actions", []):
            if action_name not in known:
                svc.actions.append(Action(name=action_name))

    for svc in services.values():
        svc.actions.sort(key=lambda a: a.name)
        svc.resources.sort(key=lambda r: r.resource)
        svc.conditions.sort(key=lambda c: c.condition)

    manifest = BuildManifest(
        generated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        n_services=len(services),
        n_actions=sum(len(s.actions) for s in services.values()),
        services_from_policygen_only=sorted(policygen_prefixes - sar_prefixes),
        services_from_sar_only=sorted(sar_prefixes - policygen_prefixes),
    )

    return services, manifest


def _write_json(path: Path, payload: object) -> int:
    """Write compact JSON and return the byte count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    path.write_text(body)
    return len(body.encode())


def write_site_data(
    services: dict[str, Service],
    policygen: dict,
    manifest: BuildManifest,
    etag: str | None,
    out: Path,
) -> None:
    svc_dir = out / "svc"
    if svc_dir.exists():
        # Clear stale shards so a service AWS removed does not linger.
        shutil.rmtree(svc_dir)

    global_data = GlobalData(
        generated_at=manifest.generated_at,
        source_etag=etag,
        condition_operators=sorted(policygen.get("conditionOperators", [])),
        global_condition_keys=sorted(policygen.get("conditionKeys", [])),
        policy_types=policygen.get("policyTypes", {}),
        partitions=PARTITIONS,
    )
    _write_json(out / "global.json", global_data.model_dump())

    index = [
        IndexEntry(
            prefix=s.prefix,
            service_name=s.service_name,
            n_actions=len(s.actions),
            has_resources=bool(s.resources),
        ).model_dump()
        for s in sorted(services.values(), key=lambda s: s.service_name.lower())
    ]
    index_bytes = _write_json(out / "index.json", index)

    shard_bytes = sum(
        _write_json(svc_dir / f"{svc.prefix}.json", svc.model_dump())
        for svc in services.values()
    )

    _write_json(out / "manifest.json", manifest.model_dump())

    logger.info(
        f"Wrote {len(services)} services, {manifest.n_actions} actions -> {out}"
    )
    logger.info(
        f"index.json {index_bytes / 1024:.0f} KB, "
        f"shards {shard_bytes / 1024 / 1024:.1f} MB total"
    )
    if manifest.services_from_policygen_only:
        logger.info(
            f"{len(manifest.services_from_policygen_only)} services from "
            f"policies.js have no Service Authorization Reference entry "
            f"(action detail will be sparse)"
        )
    if manifest.services_from_sar_only:
        logger.info(
            f"{len(manifest.services_from_sar_only)} services from the SAR "
            f"are absent from policies.js (no ARN format available)"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache",
        action="store_true",
        help="reuse downloads in build/.cache/ instead of refetching",
    )
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT, help="output directory"
    )
    args = parser.parse_args()

    policygen_body, etag = _fetch(POLICYGEN_URL, "policies.js", args.cache)
    sar_body, _ = _fetch(SAR_URL, "iam_definition.json", args.cache)

    policygen = parse_policygen(policygen_body)
    sar = json.loads(sar_body)

    services, manifest = merge(policygen, sar)
    write_site_data(services, policygen, manifest, etag, args.out)


if __name__ == "__main__":
    main()
