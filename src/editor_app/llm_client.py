from __future__ import annotations

from dataclasses import dataclass

import requests


@dataclass
class PromptConfig:
    server: str = "http://localhost:11434/v1"
    api_key: str = ""
    model: str = "gemma4:12b"


class OpenAICompatibleClient:
    def __init__(self, config: PromptConfig) -> None:
        self.config = config

    def _endpoint(self) -> str:
        return f"{self.config.server.rstrip('/')}/chat/completions"

    def complete(self, user_prompt: str) -> str:
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"

        payload = {
            "model": self.config.model,
            "messages": [{"role": "user", "content": user_prompt}],
            "temperature": 0.2,
            "stream": False,
        }

        response = requests.post(
            self._endpoint(),
            headers=headers,
            json=payload,
            timeout=120,
        )
        response.raise_for_status()
        data = response.json()

        try:
            return data["choices"][0]["message"]["content"].strip()
        except Exception as exc:  # pragma: no cover - defensive shape handling
            raise RuntimeError(f"Unexpected API response shape: {data}") from exc
