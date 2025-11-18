import json
import re
from contextlib import asynccontextmanager
from hashlib import sha256

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from loguru import logger
from starlette.responses import RedirectResponse

from app.gateway.aws import AWSCache
from app.models.models import AppCache, Settings, ServiceModel, ActionModel
import yaml

CACHE: AppCache = AppCache()
config: Settings = Settings()
aws_docs = AWSCache()


async def read_config() -> bool:
    if not config.aws.service_map_file.exists() or not config.aws.policy_file.exists():
        await refresh()

    try:
        CACHE.policies = json.loads(config.aws.policy_file.read_text())
    except json.JSONDecodeError:
        CACHE.policies = yaml.load(config.aws.policy_file, 'SafeLoader')

    temp_data = {}

    for svc, d in CACHE.policies.get("serviceMap", {}).items():
        svc_detail: dict = {
            "service_name": svc,
            "string_prefix": d.get("StringPrefix", ""),
            "actions": [],
            "arn_format": d.get("ARNFormat", ""),
            "arn_regex": d.get("ARNRegex", ""),
            "condition_keys": d.get("conditionKeys", []),
            "has_resource": d.get("HasResource", False),
        }

        temp_data.update({sha256(str.encode(svc)).hexdigest(): svc_detail})

    for idx, action in enumerate(aws_docs.iam_defs):
        for uuid, svc in temp_data.items():
            if action.get("prefix") == svc.get("string_prefix"):
                logger.debug(type(action))
                logger.debug(action.keys())
                logger.debug(action.values())
                actions = aws_docs.iam_defs[idx]
                logger.debug(actions)

                temp_data[uuid]["actions"] = ActionModel(**actions)
                logger.debug(len(temp_data))
                continue

    thing: dict = temp_data.copy()
    logger.debug(thing.keys())

    for uuid in temp_data.keys():
        logger.debug(json.dumps(thing[uuid], indent=2, default=str))
        temp_data[uuid] = ServiceModel(**thing[uuid])
        logger.debug(temp_data[uuid])
        break

    CACHE.service_map.update(thing)
    config.aws.service_map_file.write_text(
        json.dumps(jsonable_encoder(CACHE.service_map))
    )

    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(json.dumps(config.model_dump(), indent=2, default=str))

    if not await read_config():
        logger.info("Please wait...")
        await refresh()

    yield

    config.write_config()


app = FastAPI(lifespan=lifespan)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


async def fetch_policies():
    resp = httpx.get(str(config.aws.policy_generator_url))
    config.aws.etag = resp.headers["ETag"].strip("")

    json_data = json.loads(resp.text.split("=")[1])
    config.aws.policy_file.write_text(json.dumps(json_data))


@app.get("/fetch-docs")
async def fetch_docs(prefix: str, action: str):
    return JSONResponse(aws_docs.get(prefix=prefix, action=action))


@app.get("/refresh")
async def refresh():
    url = config.aws.policy_generator_url

    if not config.aws.etag or not config.aws.policy_file.exists():
        await fetch_policies()
        logger.info("Fetching new data")
    elif config.aws.etag != httpx.head(str(url)).headers["ETag"]:
        await fetch_policies()
        logger.info("New data was fetched")
    else:
        logger.info("Data is recent")

    return RedirectResponse("/ui")


@app.get("/")
async def index() -> RedirectResponse:
    return RedirectResponse("/ui")


@app.get("/services", response_class=JSONResponse)
async def services() -> JSONResponse:
    return JSONResponse(jsonable_encoder(CACHE.service_map))


@app.get("/service/{service_id}", response_class=JSONResponse)
async def service(service_id: str) -> JSONResponse:
    logger.info(service_id)
    resp_data = {}
    resp_data.update(CACHE.service_map.get(service_id))
    action_prefixes: set[str] = set()

    for action in resp_data["actions"].privileges:
        prefix = re.findall(".[^A-Z]*", action.privilege)

        if prefix:
            action_prefixes.add(prefix[0])

    resp_data.update(action_prefixes=action_prefixes)

    return JSONResponse(jsonable_encoder(resp_data))


@app.get("/ui", response_class=HTMLResponse)
async def ui(request: Request):
    service_list = {uuid: svc['service_name'] for uuid, svc in CACHE.service_map.items()}
    resp_payload = {
        "title": config.app.title,
        "service_list": dict(sorted(service_list.items(), key=lambda item: item[1])),
    }
    return templates.TemplateResponse("ui.jinja", {"request": request, **resp_payload})


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8080)
