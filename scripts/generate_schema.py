#!/usr/bin/env python3
"""Generate JSON Schema (draft 2020-12) from the frozen dataclasses in models.py.

Zero external dependencies — stdlib only.

Usage:
    python scripts/generate_schema.py          # write upload_schema.json
    python scripts/generate_schema.py --check  # compare with committed upload_schema.json
"""

from __future__ import annotations

import dataclasses
import enum
import inspect
import json
import sys
import typing
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_PATH = REPO_ROOT / "harnessarena_uploader" / "models.py"
SCHEMA_PATH = REPO_ROOT / "upload_schema.json"

# ---------------------------------------------------------------------------
# Import models dynamically so this script has zero package dependencies
# ---------------------------------------------------------------------------

def _import_models():
    """Import models.py and return the module object."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("models", MODELS_PATH)
    mod = importlib.util.module_from_spec(spec)
    # Register in sys.modules so @dataclass can resolve the module namespace
    sys.modules["models"] = mod
    spec.loader.exec_module(mod)
    return mod


models = _import_models()

# Collect all dataclasses and enums from the module
_ALL_CLASSES: dict[str, type] = {}
for _name, _obj in inspect.getmembers(models, inspect.isclass):
    if _obj.__module__ == models.__name__:
        _ALL_CLASSES[_name] = _obj

# Build a globalns that includes every name from models — needed by
# typing.get_type_hints to resolve forward references created by
# ``from __future__ import annotations``.
_GLOBALNS: dict[str, Any] = {k: v for k, v in vars(models).items()}

# ---------------------------------------------------------------------------
# JSON Schema helpers
# ---------------------------------------------------------------------------

def _is_optional(tp) -> tuple[bool, Any]:
    """Return (True, inner_type) if tp is Optional[X], else (False, tp)."""
    origin = typing.get_origin(tp)
    args = typing.get_args(tp)
    if origin is typing.Union and len(args) == 2 and type(None) in args:
        inner = args[0] if args[1] is type(None) else args[1]
        return True, inner
    return False, tp


def _schema_for_type(tp, defs: dict[str, Any]) -> dict[str, Any]:
    """Return a JSON Schema fragment for *tp*, populating *defs* as needed."""

    # --- Optional[T] --------------------------------------------------------
    is_opt, inner = _is_optional(tp)
    if is_opt:
        inner_schema = _schema_for_type(inner, defs)
        return {"anyOf": [inner_schema, {"type": "null"}]}

    # --- primitives ---------------------------------------------------------
    if tp is int:
        return {"type": "integer"}
    if tp is float:
        return {"type": "number"}
    if tp is str:
        return {"type": "string"}
    if tp is bool:
        return {"type": "boolean"}

    # --- Enum subclasses ----------------------------------------------------
    if isinstance(tp, type) and issubclass(tp, enum.Enum):
        _ensure_def(tp, defs)
        return {"$ref": f"#/$defs/{tp.__name__}"}

    # --- list / list[T] (bare list treated as array of any) -----------------
    origin = typing.get_origin(tp)
    if origin is list or tp is list:
        args = typing.get_args(tp)
        if args:
            return {"type": "array", "items": _schema_for_type(args[0], defs)}
        return {"type": "array"}

    # --- tuple[T, ...] (homogeneous variable-length, used for frozen lists) -
    if origin is tuple:
        args = typing.get_args(tp)
        if len(args) == 2 and args[1] is Ellipsis:
            return {"type": "array", "items": _schema_for_type(args[0], defs)}
        # Fixed-length tuple
        if args:
            return {
                "type": "array",
                "prefixItems": [_schema_for_type(a, defs) for a in args],
                "items": False,
            }
        return {"type": "array"}

    # --- dict / dict[K, V] (bare dict treated as object of any) -------------
    if origin is dict or tp is dict:
        args = typing.get_args(tp)
        if args and len(args) == 2:
            return {
                "type": "object",
                "additionalProperties": _schema_for_type(args[1], defs),
            }
        return {"type": "object"}

    # --- Nested dataclass ---------------------------------------------------
    if dataclasses.is_dataclass(tp) and isinstance(tp, type):
        _ensure_def(tp, defs)
        return {"$ref": f"#/$defs/{tp.__name__}"}

    # Fallback
    return {}


def _ensure_def(tp: type, defs: dict[str, Any]) -> None:
    """Add *tp* to *defs* if not already present."""
    name = tp.__name__
    if name in defs:
        return

    # Placeholder to prevent infinite recursion
    defs[name] = {}

    if isinstance(tp, type) and issubclass(tp, enum.Enum):
        members = [m.value for m in tp]
        defs[name] = {"type": "string", "enum": members}
        return

    if dataclasses.is_dataclass(tp):
        hints = typing.get_type_hints(tp, globalns=_GLOBALNS)
        fields = dataclasses.fields(tp)
        properties: dict[str, Any] = {}
        required: list[str] = []

        for f in fields:
            prop_schema = _schema_for_type(hints[f.name], defs)
            # Attach default if present
            if f.default is not dataclasses.MISSING:
                prop_schema = {**prop_schema, "default": _serialize_default(f.default)}
            elif f.default_factory is not dataclasses.MISSING:
                prop_schema = {**prop_schema, "default": _serialize_default(f.default_factory())}
            else:
                required.append(f.name)
            properties[f.name] = prop_schema

        schema: dict[str, Any] = {
            "type": "object",
            "properties": properties,
            "additionalProperties": False,
        }
        if required:
            schema["required"] = required
        defs[name] = schema


def _serialize_default(val: Any) -> Any:
    """Convert a Python default value to a JSON-safe value."""
    if isinstance(val, enum.Enum):
        return val.value
    if isinstance(val, (list, tuple)):
        return [_serialize_default(v) for v in val]
    if isinstance(val, dict):
        return {k: _serialize_default(v) for k, v in val.items()}
    if val is None or isinstance(val, (int, float, str, bool)):
        return val
    return str(val)


# ---------------------------------------------------------------------------
# Top-level schema builders
# ---------------------------------------------------------------------------

def build_schema_for(cls: type, *, schema_id: str | None = None) -> dict[str, Any]:
    """Build a complete JSON Schema document rooted at *cls*."""
    defs: dict[str, Any] = {}
    _ensure_def(cls, defs)

    root_ref = {"$ref": f"#/$defs/{cls.__name__}"}
    schema: dict[str, Any] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
    }
    if schema_id:
        schema["$id"] = schema_id
    schema.update(root_ref)
    # Sort defs alphabetically for stable output
    schema["$defs"] = dict(sorted(defs.items()))
    return schema


def build_all_schemas() -> dict[str, Any]:
    """Build the combined schema document with UploadBatch as root and
    a standalone SessionMeta schema nested under $defs."""
    defs: dict[str, Any] = {}

    # Process UploadBatch (root) — this will pull in all nested types
    _ensure_def(_ALL_CLASSES["UploadBatch"], defs)

    # Ensure SessionMeta is also present (it should be via UploadBatch, but be explicit)
    _ensure_def(_ALL_CLASSES["SessionMeta"], defs)

    schema: dict[str, Any] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://harnessarena.com/schemas/upload-batch.json",
        "version": models.HARNESSARENA_SCHEMA_VERSION,
        "$ref": "#/$defs/UploadBatch",
        "$defs": dict(sorted(defs.items())),
    }
    return schema


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    check_mode = "--check" in sys.argv

    schema = build_all_schemas()
    output = json.dumps(schema, indent=2) + "\n"

    if check_mode:
        sys.stdout.write(output)
        if SCHEMA_PATH.exists():
            committed = SCHEMA_PATH.read_text()
            if committed == output:
                print("Schema is up to date.", file=sys.stderr)
                sys.exit(0)
            else:
                print("Schema is out of date! Re-run: python scripts/generate_schema.py", file=sys.stderr)
                sys.exit(1)
        else:
            print(f"{SCHEMA_PATH} does not exist yet.", file=sys.stderr)
            sys.exit(1)
    else:
        SCHEMA_PATH.write_text(output)
        print(f"Wrote {SCHEMA_PATH}")


if __name__ == "__main__":
    main()
