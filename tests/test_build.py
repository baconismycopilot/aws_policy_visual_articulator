"""Tests for the merge step — the part most likely to break when AWS shifts."""

import json

import pytest

from build.build import merge, parse_policygen, parse_toc


@pytest.fixture
def policygen() -> dict:
    return {
        "conditionOperators": ["StringEquals"],
        "conditionKeys": ["aws:PrincipalArn"],
        "policyTypes": {"IAMPolicy": {"Name": "IAM Policy"}},
        "serviceMap": {
            "Amazon S3": {
                "StringPrefix": "s3",
                "Actions": ["GetObject", "ActionOnlyPolicygenKnows"],
                "ARNFormat": "arn:aws:s3:::${BucketName}/${KeyName}",
                "ARNRegex": "^arn:aws:s3:.+",
                "conditionKeys": ["s3:x-amz-acl"],
                "HasResource": True,
            },
            "Legacy Widget Service": {
                "StringPrefix": "widget",
                "Actions": ["Poke"],
                "ARNFormat": "arn:aws:widget:${Region}:${Account}:${RelativeId}",
                "ARNRegex": "^arn:aws:widget:.+",
                "conditionKeys": [],
                "HasResource": True,
            },
        },
    }


@pytest.fixture
def sar() -> list[dict]:
    return [
        {
            "prefix": "s3",
            "service_name": "Amazon S3",
            "privileges": [
                {
                    "privilege": "GetObject",
                    "access_level": "Read",
                    "description": "Grants permission to retrieve objects",
                    "resource_types": [
                        {
                            "resource_type": "object*",
                            "condition_keys": ["s3:ExistingObjectTag/<key>"],
                            "dependent_actions": ["kms:Decrypt"],
                        },
                        {
                            "resource_type": "",
                            "condition_keys": ["s3:signatureAge"],
                            "dependent_actions": [],
                        },
                    ],
                },
                {
                    "privilege": "PutBucketPolicy",
                    "access_level": "Permissions management, Write",
                    "description": "Grants permission to set a bucket policy",
                    "resource_types": [
                        {
                            "resource_type": "",
                            "condition_keys": [],
                            "dependent_actions": [],
                        }
                    ],
                },
            ],
            "resources": [
                {
                    "resource": "object",
                    "arn": "arn:${Partition}:s3:::${BucketName}/${ObjectName}",
                    "condition_keys": [],
                },
            ],
            "conditions": [
                {
                    "condition": "s3:prefix",
                    "description": "Filters by prefix",
                    "type": "String",
                },
            ],
        },
        {
            "prefix": "saronly",
            "service_name": "SAR Only Service",
            "privileges": [
                {
                    "privilege": "DoThing",
                    "access_level": "Write",
                    "description": "",
                    "resource_types": [],
                }
            ],
            "resources": [],
            "conditions": [],
        },
    ]


def test_parse_policygen_survives_equals_in_payload():
    body = 'app.PolicyEditorConfig={"serviceMap":{"x":{"ARNFormat":"a=b=c"}}}'
    assert parse_policygen(body)["serviceMap"]["x"]["ARNFormat"] == "a=b=c"


def test_merge_is_a_union_not_an_intersection(policygen, sar):
    services, manifest = merge(policygen, sar)

    assert set(services) == {"s3", "widget", "saronly"}
    assert manifest.services_from_policygen_only == ["widget"]
    assert manifest.services_from_sar_only == ["saronly"]


def test_required_resource_type_asterisk_is_normalized(policygen, sar):
    services, _ = merge(policygen, sar)

    get_object = next(a for a in services["s3"].actions if a.name == "GetObject")
    required = [rt for rt in get_object.resource_types if rt.required]

    assert [rt.resource_type for rt in required] == ["object"]
    assert required[0].dependent_actions == ["kms:Decrypt"]


def test_action_with_only_empty_resource_type_is_not_required(policygen, sar):
    services, _ = merge(policygen, sar)

    action = next(a for a in services["s3"].actions if a.name == "PutBucketPolicy")

    assert all(not rt.required for rt in action.resource_types)
    assert all(rt.resource_type == "" for rt in action.resource_types)


def test_comma_joined_access_levels_are_split(policygen, sar):
    """The SAR encodes multiple levels as one string, e.g. "Tagging, Write"."""
    services, _ = merge(policygen, sar)

    action = next(a for a in services["s3"].actions if a.name == "PutBucketPolicy")

    assert action.access_levels == ["Permissions management", "Write"]


def test_missing_access_level_falls_back_to_unknown(policygen, sar):
    services, _ = merge(policygen, sar)

    action = next(
        a for a in services["s3"].actions if a.name == "ActionOnlyPolicygenKnows"
    )

    assert action.access_levels == ["Unknown"]


def test_policygen_only_actions_are_added_without_clobbering_sar_detail(policygen, sar):
    services, _ = merge(policygen, sar)
    by_name = {a.name: a for a in services["s3"].actions}

    assert by_name["GetObject"].access_levels == ["Read"]
    assert by_name["ActionOnlyPolicygenKnows"].access_levels == ["Unknown"]


def test_arn_metadata_comes_from_policygen(policygen, sar):
    services, _ = merge(policygen, sar)
    s3 = services["s3"]

    assert s3.arn_format == "arn:aws:s3:::${BucketName}/${KeyName}"
    assert s3.has_resource is True
    assert "s3:x-amz-acl" in s3.service_condition_keys


def test_service_absent_from_policygen_keeps_sar_detail(policygen, sar):
    services, _ = merge(policygen, sar)

    assert services["saronly"].service_name == "SAR Only Service"
    assert services["saronly"].arn_format == ""


def test_actions_are_sorted(policygen, sar):
    services, _ = merge(policygen, sar)
    names = [a.name for a in services["s3"].actions]

    assert names == sorted(names)


def test_output_is_json_serializable(policygen, sar):
    services, manifest = merge(policygen, sar)

    json.dumps({p: s.model_dump() for p, s in services.items()})
    json.dumps(manifest.model_dump())


@pytest.fixture
def toc() -> dict:
    return {
        "contents": [
            {
                "title": "Reference",
                "href": "reference.html",
                "contents": [
                    {"title": "Amazon S3 (s3)", "href": "list_s3.html"},
                    # The page stem does not always match the prefix.
                    {"title": "Amazon MWAA (airflow)", "href": "list_mwaa.html"},
                    # Non-service pages must be ignored.
                    {"title": "Condition keys", "href": "reference_policies.html"},
                ],
            }
        ]
    }


def test_parse_toc_maps_prefix_to_page_stem(toc):
    pages = parse_toc(toc)

    assert pages == {"s3": "list_s3", "airflow": "list_mwaa"}


def test_parse_toc_ignores_non_service_pages(toc):
    assert "Condition keys" not in parse_toc(toc)
    assert all(v.startswith("list_") for v in parse_toc(toc).values())


def test_doc_page_is_attached_to_services(policygen, sar, toc):
    services, _ = merge(policygen, sar, parse_toc(toc))

    assert services["s3"].doc_page == "list_s3"
    # A service with no reference page must not invent one.
    assert services["saronly"].doc_page == ""


def test_merge_without_toc_leaves_doc_page_empty(policygen, sar):
    services, _ = merge(policygen, sar)

    assert all(s.doc_page == "" for s in services.values())
