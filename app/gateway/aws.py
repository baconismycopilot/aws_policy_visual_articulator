import json
import re
from functools import lru_cache

import httpx
from loguru import logger

from app.models.models import AWSConfig


class AWSCache:
    def __init__(self, config: AWSConfig = AWSConfig()):
        """

        Args:
            config:
        """
        self.config = config
        self.data = {}
        self.iam_defs = {}
        self.__post_init__()

    def __post_init__(self):
        self.read()

    def read(self):
        if self.config.docs_file.exists():
            logger.info(f"Reading {self.config.docs_file}")

            self.data = json.loads(self.config.docs_file.read_text())

        if self.config.iam_defs_file.exists():
            logger.info(f"Reading {self.config.iam_defs_file}")
            self.iam_defs = json.loads(self.config.iam_defs_file.read_text())

    def fetch(self) -> dict:
        logger.info(f"Fetching docs data {self.config.docs_url}")
        resp: httpx.Response = httpx.get(str(self.config.docs_url))

        if resp.is_success:
            self.data: dict = resp.json()

        return self.data

    @lru_cache(maxsize=200)
    def get(self, prefix: str, action: str) -> str:
        matcher = re.compile(rf"{prefix}.{action}", flags=re.I)

        for k in self.data.keys():
            if matcher.search(k):
                return self.data.get(k)

        return f"{prefix}.{action} not found"

    def write_docs_data(self):
        logger.info(f"Writing {self.config.docs_file}")
        self.config.docs_file.write_text(json.dumps(self.data))
