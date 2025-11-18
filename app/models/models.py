import json
from pathlib import Path

from pydantic import HttpUrl, BaseModel
from pydantic_settings import BaseSettings
from typing import Any

import yaml


class Defaults:
    config_file: Path = Path(__file__).parent.parent / "config.yaml"


class AWSConfig(BaseSettings):
    docs_url: HttpUrl = HttpUrl(
        "https://raw.githubusercontent.com/iann0036/iam-dataset/refs/heads/main/aws/docs.json"
    )
    policy_generator_url: HttpUrl = HttpUrl(
        "https://awspolicygen.s3.amazonaws.com/js/policies.js"
    )
    iam_defs_url: HttpUrl = HttpUrl(
        "https://raw.githubusercontent.com/iann0036/iam-dataset/refs/heads/main/aws/iam_definition.json"
    )
    docs_file: Path = Path(__file__).parent / "static" / "docs.json"
    policy_file: Path = Path(__file__).parent.parent / "static" / "aws_policies.json"
    iam_defs_file: Path = (
        Path(__file__).parent.parent / "static" / "iam_definitions.json"
    )
    service_map_file: Path = (
        Path(__file__).parent.parent / "static" / "service_map.json"
    )
    '''
    etag: str | None = (
        json.loads(Defaults.config_file.read_text()).get("aws").get("etag")
    )
    etag: str | None = (
        yaml.full_load(Defaults.config_file.read_bytes()).get("aws", "").get("etag", "")
    )
    '''
    etag: str | None = None


class PrivilegeModel(BaseModel):
    access_level: str
    description: str
    privilege: str
    resource_types: list[dict]


class ActionModel(BaseModel):
    conditions: list | dict | None | Any
    prefix: str | None | Any
    privileges: list[PrivilegeModel] | None | Any
    resources: list[dict] | None | Any
    service_name: str | None | Any


class ServiceModel(BaseModel):
    service_name: str
    string_prefix: str
    actions: list[ActionModel | tuple]
    arn_format: str
    arn_regex: str
    condition_keys: list[str]
    has_resource: bool


class AppCache(BaseModel):
    policies: dict = {}
    service_map: dict[str, ServiceModel] = {}


class AppConfig(BaseSettings):
    cache_file: Path = Path(__file__).parent / ".cache" / "app.json"
    config_file: Path = Defaults.config_file
    title: str = "AWS Service Map Visual Articulator"


class Settings(BaseSettings):
    app: AppConfig = AppConfig()
    aws: AWSConfig = AWSConfig()

    def write_config(self):
        self.app.config_file.write_text(json.dumps(self.model_dump(), default=str))
        self.app.config_file.write_text(yaml.dump(self.model_dump()))
