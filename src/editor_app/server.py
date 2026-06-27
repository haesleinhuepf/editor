from __future__ import annotations

import difflib
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from markdown import markdown
from pydantic import BaseModel

from editor_app.llm_client import OpenAICompatibleClient, PromptConfig


class SaveRequest(BaseModel):
    path: str
    content: str


class PromptRequest(BaseModel):
    prompt: str
    source: str


class DocumentPromptRequest(BaseModel):
    prompt: str
    document: str
    sections: list[str]


class DiffRequest(BaseModel):
    original: str
    proposed: str


class RenderRequest(BaseModel):
    text: str
    source_path: str | None = None


class PromptSettings(BaseModel):
    server: str
    api_key: str
    model: str


class InitialFileResponse(BaseModel):
    path: str | None
    content: str


def _parse_json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    candidates: list[str] = [text]

    fenced = re.search(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        candidates.append(fenced.group(1).strip())

    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last != -1 and first < last:
        candidates.append(text[first : last + 1])

    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data

    raise ValueError("LLM did not return a valid JSON object.")


def _int_value(raw: Any) -> int | None:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _parse_document_action(raw: str, section_count: int) -> dict[str, Any]:
    data = _parse_json_object(raw)
    action = str(data.get("action") or data.get("mode") or "").strip().lower()

    if action == "rewrite":
        document = data.get("document")
        if not isinstance(document, str):
            raise ValueError("Rewrite action requires a string field named 'document'.")
        return {"action": "rewrite", "document": document}

    if action == "replace_sections":
        replacements_raw = data.get("replacements")
        if not isinstance(replacements_raw, list):
            raise ValueError("replace_sections action requires a list field named 'replacements'.")

        replacements: list[dict[str, Any]] = []
        for item in replacements_raw:
            if not isinstance(item, dict):
                raise ValueError("Each replacement entry must be an object.")

            section_number = _int_value(
                item.get("section_number", item.get("section", item.get("index")))
            )
            if section_number is None:
                raise ValueError("Each replacement must include an integer 'section_number'.")
            if section_number < 1 or section_number > section_count:
                raise ValueError(
                    f"Replacement section_number {section_number} is out of range (1..{section_count})."
                )

            content = item.get("content", item.get("replacement"))
            if not isinstance(content, str):
                raise ValueError("Each replacement must include string field 'content'.")

            replacements.append({"section_number": section_number, "content": content})

        return {"action": "replace_sections", "replacements": replacements}

    raise ValueError("Action must be either 'rewrite' or 'replace_sections'.")


def _section_preview(section: str) -> str:
    for line in section.splitlines():
        text = line.strip()
        if text:
            return text[:120]
    return "(empty section)"


def _web_dir() -> Path:
    return Path(__file__).resolve().parent / "web"


def _is_external_or_absolute_url(url: str) -> bool:
    lowered = url.lower()
    if lowered.startswith(("http://", "https://", "data:", "file:", "mailto:", "javascript:")):
        return True
    if url.startswith(("/", "#")):
        return True
    return bool(re.match(r"^[a-zA-Z]:[\\/]", url))


def _rewrite_image_sources(html: str, base_dir: Path | None) -> str:
    if not base_dir:
        return html

    def replace(match: re.Match[str]) -> str:
        prefix, quote_char, src, _ = match.groups()
        if _is_external_or_absolute_url(src):
            return match.group(0)

        resolved_path = (base_dir / src).resolve()
        served_src = f"/api/file/asset?path={quote(str(resolved_path))}"
        return f"{prefix}{quote_char}{served_src}{quote_char}"

    return re.sub(r'(<img\b[^>]*?\bsrc\s*=\s*)(["\'])([^"\']+)(\2)', replace, html, flags=re.IGNORECASE)


def create_app(initial_path: str | None = None) -> FastAPI:
    app = FastAPI(title="editor")
    app.state.prompt_config = PromptConfig()
    app.state.initial_path = str(Path(initial_path).resolve()) if initial_path else None

    web_dir = _web_dir()
    app.mount("/static", StaticFiles(directory=str(web_dir)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(web_dir / "index.html")

    @app.get("/api/initial-file", response_model=InitialFileResponse)
    def initial_file() -> InitialFileResponse:
        path_value = app.state.initial_path
        if not path_value:
            return InitialFileResponse(path=None, content="")

        path = Path(path_value)
        if not path.exists():
            return InitialFileResponse(path=str(path), content="")

        try:
            content = path.read_text(encoding="utf-8")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read initial file: {exc}") from exc
        return InitialFileResponse(path=str(path), content=content)

    @app.get("/api/file/load")
    def load_file(path: str) -> dict[str, Any]:
        file_path = Path(path)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read file: {exc}") from exc

        return {"path": str(file_path), "content": content}

    @app.get("/api/file/asset")
    def load_asset(path: str) -> FileResponse:
        asset_path = Path(path)
        if not asset_path.exists() or not asset_path.is_file():
            raise HTTPException(status_code=404, detail=f"Asset not found: {asset_path}")
        return FileResponse(asset_path)

    @app.post("/api/file/save")
    def save_file(request: SaveRequest) -> dict[str, str]:
        file_path = Path(request.path)
        try:
            file_path.write_text(request.content, encoding="utf-8")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not write file: {exc}") from exc

        return {"path": str(file_path)}

    @app.get("/api/settings")
    def get_settings() -> dict[str, str]:
        cfg: PromptConfig = app.state.prompt_config
        return {"server": cfg.server, "api_key": cfg.api_key, "model": cfg.model}

    @app.post("/api/settings")
    def set_settings(settings: PromptSettings) -> dict[str, str]:
        app.state.prompt_config = PromptConfig(
            server=settings.server.strip() or "http://localhost:11434/v1",
            api_key=settings.api_key.strip(),
            model=settings.model.strip() or "gemma4:12b",
        )
        return {"status": "ok"}

    @app.post("/api/prompt/edit")
    def prompt_edit(request: PromptRequest) -> dict[str, str]:
        cfg: PromptConfig = app.state.prompt_config
        client = OpenAICompatibleClient(cfg)

        payload = (
            "You are editing markdown. Return only markdown text for the updated content.\\n\\n"
            f"User prompt:\\n{request.prompt}\\n\\n"
            "Source markdown:\\n"
            f"{request.source}"
        )
        try:
            result = client.complete(payload)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"result": result}

    @app.post("/api/prompt/insert")
    def prompt_insert(request: PromptRequest) -> dict[str, str]:
        cfg: PromptConfig = app.state.prompt_config
        client = OpenAICompatibleClient(cfg)

        payload = (
            "Generate one or more markdown sections. Return only markdown. "
            "Separate sections with a line containing exactly '<!-- section -->'.\\n\\n"
            f"Prompt:\\n{request.prompt}"
        )
        try:
            result = client.complete(payload)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"result": result}

    @app.post("/api/prompt/document")
    def prompt_document(request: DocumentPromptRequest) -> dict[str, Any]:
        cfg: PromptConfig = app.state.prompt_config
        client = OpenAICompatibleClient(cfg)

        previews = "\n".join(
            f"{idx + 1}. {_section_preview(section)}" for idx, section in enumerate(request.sections)
        )

        payload = (
            "You are a markdown editor. The user prompt applies to the entire document.\n"
            "You must choose exactly one action and return only valid JSON (no prose, no markdown fences):\n"
            "1) Rewrite the entire document:\n"
            '{"action":"rewrite","document":"<full markdown document>"}\n'
            "2) Replace specific sections only:\n"
            '{"action":"replace_sections","replacements":[{"section_number":1,"content":"<full replacement markdown for that section>"}]}\n\n'
            "Rules:\n"
            "- section_number is 1-based and must refer to an existing section.\n"
            "- For replace_sections, only include sections that change.\n"
            "- Keep markdown valid.\n"
            "- Return exactly one JSON object.\n\n"
            f"User prompt:\n{request.prompt}\n\n"
            f"Section count: {len(request.sections)}\n"
            f"Section previews:\n{previews}\n\n"
            "Full document:\n"
            f"{request.document}"
        )

        try:
            result = client.complete(payload)
            return _parse_document_action(result, section_count=len(request.sections))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid LLM response: {exc}") from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/diff")
    def create_diff(request: DiffRequest) -> dict[str, Any]:
        original_lines = request.original.splitlines()
        proposed_lines = request.proposed.splitlines()
        matcher = difflib.SequenceMatcher(a=original_lines, b=proposed_lines)

        lines: list[dict[str, str]] = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                for line in original_lines[i1:i2]:
                    lines.append({"kind": "context", "text": line})
            elif tag == "delete":
                for line in original_lines[i1:i2]:
                    lines.append({"kind": "remove", "text": line})
            elif tag == "insert":
                for line in proposed_lines[j1:j2]:
                    lines.append({"kind": "add", "text": line})
            elif tag == "replace":
                for line in original_lines[i1:i2]:
                    lines.append({"kind": "remove", "text": line})
                for line in proposed_lines[j1:j2]:
                    lines.append({"kind": "add", "text": line})

        return {"lines": lines}

    @app.post("/api/markdown/render")
    def render_markdown(request: RenderRequest) -> dict[str, str]:
        html = markdown(request.text, extensions=["fenced_code", "tables"])
        base_dir = Path(request.source_path).resolve().parent if request.source_path else None
        html = _rewrite_image_sources(html, base_dir)
        return {"html": html}

    return app
