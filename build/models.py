"""Validated shapes for the generated site data.

These models exist to make the build fail loudly when AWS changes the upstream
schema, rather than shipping subtly broken shards to the browser.
"""

from pydantic import BaseModel


class ResourceTypeRef(BaseModel):
    """A resource type an action can act on.

    The Service Authorization Reference marks required resource types with a
    trailing asterisk (``object*``). We strip it and carry a boolean instead, so
    the frontend can enforce "this action cannot use Resource: *".
    """

    resource_type: str
    required: bool = False
    condition_keys: list[str] = []
    dependent_actions: list[str] = []


class Action(BaseModel):
    """A single IAM action.

    ``access_levels`` is a list because the Service Authorization Reference
    assigns more than one to ~1,050 actions -- ``"Permissions management,
    Write"`` and ``"Tagging, Write"`` are single upstream strings. Treating it
    as a scalar drops most permission-management actions on the floor.
    """

    name: str
    access_levels: list[str] = ["Unknown"]
    description: str = ""
    resource_types: list[ResourceTypeRef] = []


class ResourceType(BaseModel):
    resource: str
    arn: str
    condition_keys: list[str] = []


class ConditionKey(BaseModel):
    condition: str
    description: str = ""
    type: str = "String"


class Service(BaseModel):
    prefix: str
    service_name: str
    arn_format: str = ""
    arn_regex: str = ""
    has_resource: bool = False
    service_condition_keys: list[str] = []
    actions: list[Action] = []
    resources: list[ResourceType] = []
    conditions: list[ConditionKey] = []


class IndexEntry(BaseModel):
    prefix: str
    service_name: str
    n_actions: int
    has_resources: bool


class GlobalData(BaseModel):
    generated_at: str
    source_etag: str | None = None
    condition_operators: list[str] = []
    global_condition_keys: list[str] = []
    policy_types: dict[str, dict] = {}
    partitions: list[str] = []


class BuildManifest(BaseModel):
    generated_at: str
    n_services: int
    n_actions: int
    services_from_policygen_only: list[str] = []
    services_from_sar_only: list[str] = []
