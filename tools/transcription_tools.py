#!/usr/bin/env python3
"""
Transcription Tools Module

Provides speech-to-text transcription with six providers:

  - **local** (default, free) — faster-whisper running locally, no API key needed.
    Auto-downloads the model (~150 MB for ``base``) on first use.
  - **groq** (free tier) — Groq Whisper API, requires ``GROQ_API_KEY``.
  - **openai** (paid) — OpenAI Whisper API, requires ``VOICE_TOOLS_OPENAI_KEY``.
  - **mistral** — Mistral Voxtral Transcribe API, requires ``MISTRAL_API_KEY``.
  - **xai** — xAI Grok STT API, requires ``XAI_API_KEY``. High accuracy,
    Inverse Text Normalization, diarization, 21 languages.

Used by the messaging gateway to automatically transcribe voice messages
sent by users on Telegram, Discord, WhatsApp, Slack, and Signal.

Supported input formats: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, aac

Usage::

    from tools.transcription_tools import transcribe_audio

    result = transcribe_audio("/path/to/audio.ogg")
    if result["success"]:
        print(result["transcript"])
"""

import logging
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional, Dict, Any
from urllib.parse import urljoin

from utils import is_truthy_value
from tools.managed_tool_gateway import resolve_managed_tool_gateway
from tools.tool_backend_helpers import managed_nous_tools_enabled, resolve_openai_audio_api_key

logger = logging.getLogger(__name__)

def get_env_value(name, default=None):
    """Read env values through the live config module.

    Tests may monkeypatch and later restore ``hermes_cli.config.get_env_value``
    before this module is imported. Resolve the helper at call time so STT does
    not keep a stale imported function for the rest of the test process.
    """
    try:
        from hermes_cli.config import get_env_value as _get_env_value
    except ImportError:
        return os.getenv(name, default)
    value = _get_env_value(name)
    return default if value is None else value

# ---------------------------------------------------------------------------
# Optional imports — graceful degradation
# ---------------------------------------------------------------------------

import importlib.util as _ilu


def _safe_find_spec(module_name: str) -> bool:
    try:
        return _ilu.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return module_name in globals() or module_name in os.sys.modules


_HAS_FASTER_WHISPER = _safe_find_spec("faster_whisper")
_HAS_OPENAI = _safe_find_spec("openai")
_HAS_MISTRAL = _safe_find_spec("mistralai")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_PROVIDER = "local"
DEFAULT_LOCAL_MODEL = "base"
DEFAULT_LOCAL_STT_LANGUAGE = "en"
DEFAULT_STT_MODEL = os.getenv("STT_OPENAI_MODEL", "whisper-1")
DEFAULT_GROQ_STT_MODEL = os.getenv("STT_GROQ_MODEL", "whisper-large-v3-turbo")
DEFAULT_MISTRAL_STT_MODEL = os.getenv("STT_MISTRAL_MODEL", "voxtral-mini-latest")
DEFAULT_PARAFORMER_STT_MODEL = os.getenv("STT_PARAFORMER_MODEL", "qwen3-asr-flash-2026-02-10")
LOCAL_STT_COMMAND_ENV = "HERMES_LOCAL_STT_COMMAND"
LOCAL_STT_LANGUAGE_ENV = "HERMES_LOCAL_STT_LANGUAGE"
COMMON_LOCAL_BIN_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")

GROQ_BASE_URL = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
OPENAI_BASE_URL = os.getenv("STT_OPENAI_BASE_URL", "https://api.openai.com/v1")
XAI_STT_BASE_URL = os.getenv("XAI_STT_BASE_URL", "https://api.x.ai/v1")
PARAFORMER_BASE_URL = os.getenv(
    "STT_PARAFORMER_BASE_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
)

SUPPORTED_FORMATS = {".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".aac", ".flac", ".silk", ".amr"}
LOCAL_NATIVE_AUDIO_FORMATS = {".wav", ".aiff", ".aif"}
# Formats that cloud STT APIs (OpenAI, DashScope/Paraformer) typically reject.
# Files in these formats are auto-converted to .wav via ffmpeg before upload.
_NONSTANDARD_AUDIO_FORMATS = {".silk", ".amr", ".opus"}
MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB

# Known model sets for auto-correction
OPENAI_MODELS = {"whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"}
GROQ_MODELS = {"whisper-large-v3", "whisper-large-v3-turbo", "distil-whisper-large-v3-en"}

# Singleton for the local model — loaded once, reused across calls
_local_model: Optional[object] = None
_local_model_name: Optional[str] = None

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------



def _load_stt_config() -> dict:
    """Load the ``stt`` section from user config, falling back to defaults."""
    try:
        from hermes_cli.config import load_config
        return load_config().get("stt", {})
    except Exception:
        return {}


def is_stt_enabled(stt_config: Optional[dict] = None) -> bool:
    """Return whether STT is enabled in config."""
    if stt_config is None:
        stt_config = _load_stt_config()
    enabled = stt_config.get("enabled", True)
    return is_truthy_value(enabled, default=True)


def _has_openai_audio_backend() -> bool:
    """Return True when OpenAI audio can use config credentials, env credentials, or the managed gateway."""
    try:
        _resolve_openai_audio_client_config()
        return True
    except ValueError:
        return False


def _find_binary(binary_name: str) -> Optional[str]:
    """Find a local binary, checking common Homebrew/local prefixes as well as PATH."""
    for directory in COMMON_LOCAL_BIN_DIRS:
        candidate = Path(directory) / binary_name
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return shutil.which(binary_name)


def _find_ffmpeg_binary() -> Optional[str]:
    return _find_binary("ffmpeg")


def _find_whisper_binary() -> Optional[str]:
    return _find_binary("whisper")


def _get_local_command_template() -> Optional[str]:
    configured = os.getenv(LOCAL_STT_COMMAND_ENV, "").strip()
    if configured:
        return configured

    whisper_binary = _find_whisper_binary()
    if whisper_binary:
        quoted_binary = shlex.quote(whisper_binary)
        return (
            f"{quoted_binary} {{input_path}} --model {{model}} --output_format txt "
            "--output_dir {output_dir} --language {language}"
        )
    return None


def _has_local_command() -> bool:
    return _get_local_command_template() is not None


def _normalize_local_model(model_name: Optional[str]) -> str:
    """Return a valid faster-whisper model size, mapping cloud-only names to the default.

    Cloud providers like OpenAI use names such as ``whisper-1`` which are not
    valid for faster-whisper (which expects ``tiny``, ``base``, ``small``,
    ``medium``, or ``large-v*``).  When such a name is detected we fall back to
    the default local model and emit a warning so the user knows what happened.
    """
    if not model_name or model_name in OPENAI_MODELS or model_name in GROQ_MODELS:
        if model_name and (model_name in OPENAI_MODELS or model_name in GROQ_MODELS):
            logger.warning(
                "STT model '%s' is a cloud-only name and cannot be used with the local "
                "provider. Falling back to '%s'. Set stt.local.model to a valid "
                "faster-whisper size (tiny, base, small, medium, large-v3).",
                model_name,
                DEFAULT_LOCAL_MODEL,
            )
        return DEFAULT_LOCAL_MODEL
    return model_name


def _normalize_local_command_model(model_name: Optional[str]) -> str:
    return _normalize_local_model(model_name)


def _get_provider(stt_config: dict) -> str:
    """Determine which STT provider to use.

    When ``stt.provider`` is explicitly set in config, that choice is
    honoured — no silent cloud fallback.  When no provider is configured,
    auto-detect tries: local > groq (free) > openai (paid).
    """
    if not is_stt_enabled(stt_config):
        return "none"

    explicit = "provider" in stt_config
    provider = stt_config.get("provider", DEFAULT_PROVIDER)

    # --- Explicit provider: respect the user's choice ----------------------

    if explicit:
        if provider == "local":
            if _HAS_FASTER_WHISPER:
                return "local"
            if _has_local_command():
                return "local_command"
            logger.warning(
                "STT provider 'local' configured but unavailable "
                "(install faster-whisper or set HERMES_LOCAL_STT_COMMAND)"
            )
            return "none"

        if provider == "local_command":
            if _has_local_command():
                return "local_command"
            if _HAS_FASTER_WHISPER:
                logger.info("Local STT command unavailable, using local faster-whisper")
                return "local"
            logger.warning(
                "STT provider 'local_command' configured but unavailable"
            )
            return "none"

        if provider == "groq":
            if _HAS_OPENAI and get_env_value("GROQ_API_KEY"):
                return "groq"
            logger.warning(
                "STT provider 'groq' configured but GROQ_API_KEY not set"
            )
            return "none"

        if provider == "openai":
            if _HAS_OPENAI and _has_openai_audio_backend():
                return "openai"
            logger.warning(
                "STT provider 'openai' configured but no API key available"
            )
            return "none"

        if provider == "mistral":
            # `mistralai` PyPI package was quarantined on 2026-05-12 after a
            # malicious 2.4.6 release. Refuse to use this provider until it's
            # available again so we surface a clear message instead of an
            # opaque ImportError mid-call.
            logger.warning(
                "STT provider 'mistral' (Voxtral Transcribe) is temporarily "
                "disabled — `mistralai` PyPI package is quarantined "
                "(malicious 2.4.6 release on 2026-05-12). Falling back to "
                "another provider. Set stt.provider in config.yaml to 'local' "
                "or 'openai' to silence this warning."
            )
            return "none"

        if provider == "xai":
            from tools.xai_http import resolve_xai_http_credentials

            if resolve_xai_http_credentials().get("api_key"):
                return "xai"
            logger.warning(
                "STT provider 'xai' configured but no xAI credentials are available"
            )
            return "none"

        if provider == "paraformer":
            if _resolve_paraformer_api_key(stt_config):
                return "paraformer"
            logger.warning(
                "STT provider 'paraformer' configured but no DashScope API key "
                "is available (set stt.paraformer.api_key or DASHSCOPE_API_KEY)"
            )
            return "none"

        return provider  # Unknown — let it fail downstream

    # --- Auto-detect (no explicit provider): local > groq > openai > xai ---
    # mistral is intentionally skipped while `mistralai` is quarantined on
    # PyPI (malicious 2.4.6 release on 2026-05-12).

    if _HAS_FASTER_WHISPER:
        return "local"
    if _has_local_command():
        return "local_command"
    if _HAS_OPENAI and get_env_value("GROQ_API_KEY"):
        logger.info("No local STT available, using Groq Whisper API")
        return "groq"
    if _HAS_OPENAI and _has_openai_audio_backend():
        logger.info("No local STT available, using OpenAI Whisper API")
        return "openai"
    if _resolve_paraformer_api_key(stt_config):
        logger.info("No local STT available, using DashScope Paraformer API")
        return "paraformer"
    try:
        from tools.xai_http import resolve_xai_http_credentials

        if resolve_xai_http_credentials().get("api_key"):
            logger.info("No local STT available, using xAI Grok STT API")
            return "xai"
    except Exception:
        pass
    return "none"

# ---------------------------------------------------------------------------
# Shared validation
# ---------------------------------------------------------------------------


def _validate_audio_file(file_path: str) -> Optional[Dict[str, Any]]:
    """Validate the audio file.  Returns an error dict or None if OK."""
    audio_path = Path(file_path)

    if not audio_path.exists():
        return {"success": False, "transcript": "", "error": f"Audio file not found: {file_path}"}
    if not audio_path.is_file():
        return {"success": False, "transcript": "", "error": f"Path is not a file: {file_path}"}
    if audio_path.suffix.lower() not in SUPPORTED_FORMATS:
        return {
            "success": False,
            "transcript": "",
            "error": f"Unsupported format: {audio_path.suffix}. Supported: {', '.join(sorted(SUPPORTED_FORMATS))}",
        }
    try:
        file_size = audio_path.stat().st_size
        if file_size > MAX_FILE_SIZE:
            return {
                "success": False,
                "transcript": "",
                "error": f"File too large: {file_size / (1024*1024):.1f}MB (max {MAX_FILE_SIZE / (1024*1024):.0f}MB)",
            }
    except OSError as e:
        return {"success": False, "transcript": "", "error": f"Failed to access file: {e}"}

    return None

# ---------------------------------------------------------------------------
# Provider: local (faster-whisper)
# ---------------------------------------------------------------------------


# Substrings that identify a missing/unloadable CUDA runtime library.  When
# ctranslate2 (the backend for faster-whisper) cannot dlopen one of these, the
# "auto" device picker has already committed to CUDA and the model can no
# longer be used — we fall back to CPU and reload.
#
# Deliberately narrow: we match on library-name tokens and dlopen phrasing so
# we DO NOT accidentally catch legitimate runtime failures like "CUDA out of
# memory" — those should surface to the user, not silently fall back to CPU
# (a 32GB audio clip on CPU at int8 isn't useful either).
_CUDA_LIB_ERROR_MARKERS = (
    "libcublas",
    "libcudnn",
    "libcudart",
    "cannot be loaded",
    "cannot open shared object",
    "no kernel image is available",
    "no CUDA-capable device",
    "CUDA driver version is insufficient",
)


def _looks_like_cuda_lib_error(exc: BaseException) -> bool:
    """Heuristic: is this exception a missing/broken CUDA runtime library?

    ctranslate2 raises plain RuntimeError with messages like
    ``Library libcublas.so.12 is not found or cannot be loaded``.  We want to
    catch missing/unloadable shared libs and driver-mismatch errors, NOT
    legitimate runtime failures ("CUDA out of memory", model bugs, etc.).
    """
    msg = str(exc)
    return any(marker in msg for marker in _CUDA_LIB_ERROR_MARKERS)


def _load_local_whisper_model(model_name: str):
    """Load faster-whisper with graceful CUDA → CPU fallback.

    faster-whisper's ``device="auto"`` picks CUDA when the ctranslate2 wheel
    ships CUDA shared libs, even on hosts where the NVIDIA runtime
    (``libcublas.so.12`` / ``libcudnn*``) isn't installed — common on WSL2
    without CUDA-on-WSL, headless servers, and CPU-only developer machines.
    On those hosts the load itself sometimes succeeds and the dlopen failure
    only surfaces at first ``transcribe()`` call.

    We try ``auto`` first (fast CUDA path when it works), and on any CUDA
    library load failure fall back to CPU + int8.
    """
    from faster_whisper import WhisperModel
    try:
        return WhisperModel(model_name, device="auto", compute_type="auto")
    except Exception as exc:
        if not _looks_like_cuda_lib_error(exc):
            raise
        logger.warning(
            "faster-whisper CUDA load failed (%s) — falling back to CPU (int8). "
            "Install the NVIDIA CUDA runtime (libcublas/libcudnn) to use GPU.",
            exc,
        )
        return WhisperModel(model_name, device="cpu", compute_type="int8")


def _transcribe_local(file_path: str, model_name: str) -> Dict[str, Any]:
    """Transcribe using faster-whisper (local, free)."""
    global _local_model, _local_model_name

    if not _HAS_FASTER_WHISPER:
        return {"success": False, "transcript": "", "error": "faster-whisper not installed"}

    try:
        # Lazy-load the model (downloads on first use, ~150 MB for 'base')
        if _local_model is None or _local_model_name != model_name:
            logger.info("Loading faster-whisper model '%s' (first load downloads the model)...", model_name)
            _local_model = _load_local_whisper_model(model_name)
            _local_model_name = model_name

        # Language: config.yaml (stt.local.language) > env var > auto-detect.
        _forced_lang = (
            _load_stt_config().get("local", {}).get("language")
            or os.getenv(LOCAL_STT_LANGUAGE_ENV)
            or None
        )
        transcribe_kwargs = {"beam_size": 5}
        if _forced_lang:
            transcribe_kwargs["language"] = _forced_lang

        try:
            segments, info = _local_model.transcribe(file_path, **transcribe_kwargs)
            transcript = " ".join(segment.text.strip() for segment in segments)
        except Exception as exc:
            # CUDA runtime libs sometimes only fail at dlopen-on-first-use,
            # AFTER the model loaded successfully.  Evict the broken cached
            # model, reload on CPU, retry once.  Without this the module-
            # global `_local_model` is poisoned and every subsequent voice
            # message on this process fails identically until restart.
            if not _looks_like_cuda_lib_error(exc):
                raise
            logger.warning(
                "faster-whisper CUDA runtime failed mid-transcribe (%s) — "
                "evicting cached model and retrying on CPU (int8).",
                exc,
            )
            _local_model = None
            _local_model_name = None
            from faster_whisper import WhisperModel
            _local_model = WhisperModel(model_name, device="cpu", compute_type="int8")
            _local_model_name = model_name
            segments, info = _local_model.transcribe(file_path, **transcribe_kwargs)
            transcript = " ".join(segment.text.strip() for segment in segments)

        logger.info(
            "Transcribed %s via local whisper (%s, lang=%s, %.1fs audio)",
            Path(file_path).name, model_name, info.language, info.duration,
        )

        return {"success": True, "transcript": transcript, "provider": "local"}

    except Exception as e:
        logger.error("Local transcription failed: %s", e, exc_info=True)
        return {"success": False, "transcript": "", "error": f"Local transcription failed: {e}"}


def _prepare_local_audio(file_path: str, work_dir: str) -> tuple[Optional[str], Optional[str]]:
    """Normalize audio for local CLI STT when needed."""
    audio_path = Path(file_path)
    if audio_path.suffix.lower() in LOCAL_NATIVE_AUDIO_FORMATS:
        return file_path, None

    ffmpeg = _find_ffmpeg_binary()
    if not ffmpeg:
        return None, "Local STT fallback requires ffmpeg for non-WAV inputs, but ffmpeg was not found"

    converted_path = os.path.join(work_dir, f"{audio_path.stem}.wav")
    command = [ffmpeg, "-y", "-i", file_path, converted_path]

    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
        return converted_path, None
    except subprocess.CalledProcessError as e:
        details = e.stderr.strip() or e.stdout.strip() or str(e)
        logger.error("ffmpeg conversion failed for %s: %s", file_path, details)
        return None, f"Failed to convert audio for local STT: {details}"


def _transcribe_local_command(file_path: str, model_name: str) -> Dict[str, Any]:
    """Run the configured local STT command template and read back a .txt transcript."""
    command_template = _get_local_command_template()
    if not command_template:
        return {
            "success": False,
            "transcript": "",
            "error": (
                f"{LOCAL_STT_COMMAND_ENV} not configured and no local whisper binary was found"
            ),
        }

    # Language: config.yaml (stt.local.language) > env var > "en" default.
    language = (
        _load_stt_config().get("local", {}).get("language")
        or os.getenv(LOCAL_STT_LANGUAGE_ENV)
        or DEFAULT_LOCAL_STT_LANGUAGE
    )
    normalized_model = _normalize_local_command_model(model_name)

    try:
        with tempfile.TemporaryDirectory(prefix="hermes-local-stt-") as output_dir:
            prepared_input, prep_error = _prepare_local_audio(file_path, output_dir)
            if prep_error:
                return {"success": False, "transcript": "", "error": prep_error}

            command = command_template.format(
                input_path=shlex.quote(prepared_input),
                output_dir=shlex.quote(output_dir),
                language=shlex.quote(language),
                model=shlex.quote(normalized_model),
            )
            # User-provided templates (env var) may contain shell syntax; auto-detected commands are safe for list mode.
            use_shell = bool(os.getenv(LOCAL_STT_COMMAND_ENV, "").strip())
            if use_shell:
                subprocess.run(command, shell=True, check=True, capture_output=True, text=True)
            else:
                subprocess.run(shlex.split(command), check=True, capture_output=True, text=True)
            

            txt_files = sorted(Path(output_dir).glob("*.txt"))
            if not txt_files:
                return {
                    "success": False,
                    "transcript": "",
                    "error": "Local STT command completed but did not produce a .txt transcript",
                }

            transcript_text = txt_files[0].read_text(encoding="utf-8").strip()
            logger.info(
                "Transcribed %s via local STT command (%s, %d chars)",
                Path(file_path).name,
                normalized_model,
                len(transcript_text),
            )
            return {"success": True, "transcript": transcript_text, "provider": "local_command"}

    except KeyError as e:
        return {
            "success": False,
            "transcript": "",
            "error": f"Invalid {LOCAL_STT_COMMAND_ENV} template, missing placeholder: {e}",
        }
    except subprocess.CalledProcessError as e:
        details = e.stderr.strip() or e.stdout.strip() or str(e)
        logger.error("Local STT command failed for %s: %s", file_path, details)
        return {"success": False, "transcript": "", "error": f"Local STT failed: {details}"}
    except Exception as e:
        logger.error("Unexpected error during local command transcription: %s", e, exc_info=True)
        return {"success": False, "transcript": "", "error": f"Local transcription failed: {e}"}

# ---------------------------------------------------------------------------
# Provider: groq (Whisper API — free tier)
# ---------------------------------------------------------------------------


def _transcribe_groq(file_path: str, model_name: str) -> Dict[str, Any]:
    """Transcribe using Groq Whisper API (free tier available)."""
    api_key = get_env_value("GROQ_API_KEY")
    if not api_key:
        return {"success": False, "transcript": "", "error": "GROQ_API_KEY not set"}

    if not _HAS_OPENAI:
        return {"success": False, "transcript": "", "error": "openai package not installed"}

    # Auto-correct model if caller passed an OpenAI-only model
    if model_name in OPENAI_MODELS:
        logger.info("Model %s not available on Groq, using %s", model_name, DEFAULT_GROQ_STT_MODEL)
        model_name = DEFAULT_GROQ_STT_MODEL

    try:
        from openai import OpenAI, APIError, APIConnectionError, APITimeoutError
        client = OpenAI(api_key=api_key, base_url=GROQ_BASE_URL, timeout=30, max_retries=0)
        try:
            with open(file_path, "rb") as audio_file:
                transcription = client.audio.transcriptions.create(
                    model=model_name,
                    file=audio_file,
                    response_format="text",
                )

            transcript_text = str(transcription).strip()
            logger.info("Transcribed %s via Groq API (%s, %d chars)",
                         Path(file_path).name, model_name, len(transcript_text))

            return {"success": True, "transcript": transcript_text, "provider": "groq"}
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                close()

    except PermissionError:
        return {"success": False, "transcript": "", "error": f"Permission denied: {file_path}"}
    except APIConnectionError as e:
        return {"success": False, "transcript": "", "error": f"Connection error: {e}"}
    except APITimeoutError as e:
        return {"success": False, "transcript": "", "error": f"Request timeout: {e}"}
    except APIError as e:
        return {"success": False, "transcript": "", "error": f"API error: {e}"}
    except Exception as e:
        logger.error("Groq transcription failed: %s", e, exc_info=True)
        return {"success": False, "transcript": "", "error": f"Transcription failed: {e}"}

# ---------------------------------------------------------------------------
# Provider: openai (Whisper API)
# ---------------------------------------------------------------------------


def _transcribe_openai(file_path: str, model_name: str) -> Dict[str, Any]:
    """Transcribe using OpenAI Whisper API (paid)."""
    try:
        api_key, base_url = _resolve_openai_audio_client_config()
    except ValueError as exc:
        return {
            "success": False,
            "transcript": "",
            "error": str(exc),
        }

    if not _HAS_OPENAI:
        return {"success": False, "transcript": "", "error": "openai package not installed"}

    # Auto-correct model if caller passed a Groq-only model
    if model_name in GROQ_MODELS:
        logger.info("Model %s not available on OpenAI, using %s", model_name, DEFAULT_STT_MODEL)
        model_name = DEFAULT_STT_MODEL

    try:
        from openai import OpenAI, APIError, APIConnectionError, APITimeoutError
        client = OpenAI(api_key=api_key, base_url=base_url, timeout=30, max_retries=0)
        try:
            with open(file_path, "rb") as audio_file:
                transcription = client.audio.transcriptions.create(
                    model=model_name,
                    file=audio_file,
                    response_format="text" if model_name == "whisper-1" else "json",
                )

            transcript_text = _extract_transcript_text(transcription)
            logger.info("Transcribed %s via OpenAI API (%s, %d chars)",
                         Path(file_path).name, model_name, len(transcript_text))

            return {"success": True, "transcript": transcript_text, "provider": "openai"}
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                close()

    except PermissionError:
        return {"success": False, "transcript": "", "error": f"Permission denied: {file_path}"}
    except APIConnectionError as e:
        return {"success": False, "transcript": "", "error": f"Connection error: {e}"}
    except APITimeoutError as e:
        return {"success": False, "transcript": "", "error": f"Request timeout: {e}"}
    except APIError as e:
        return {"success": False, "transcript": "", "error": f"API error: {e}"}
    except Exception as e:
        logger.error("OpenAI transcription failed: %s", e, exc_info=True)
        return {"success": False, "transcript": "", "error": f"Transcription failed: {e}"}

# ---------------------------------------------------------------------------
# Provider: mistral (Voxtral Transcribe API)
# ---------------------------------------------------------------------------


def _transcribe_mistral(file_path: str, model_name: str) -> Dict[str, Any]:
    """Transcribe using Mistral Voxtral Transcribe API.

    Uses the ``mistralai`` Python SDK to call ``/v1/audio/transcriptions``.
    Requires ``MISTRAL_API_KEY`` environment variable.
    """
    api_key = get_env_value("MISTRAL_API_KEY")
    if not api_key:
        return {"success": False, "transcript": "", "error": "MISTRAL_API_KEY not set"}

    try:
        from mistralai.client import Mistral

        with Mistral(api_key=api_key) as client:
            with open(file_path, "rb") as audio_file:
                result = client.audio.transcriptions.complete(
                    model=model_name,
                    file={"content": audio_file, "file_name": Path(file_path).name},
                )

            transcript_text = _extract_transcript_text(result)
            logger.info(
                "Transcribed %s via Mistral API (%s, %d chars)",
                Path(file_path).name, model_name, len(transcript_text),
            )
            return {"success": True, "transcript": transcript_text, "provider": "mistral"}

    except PermissionError:
        return {"success": False, "transcript": "", "error": f"Permission denied: {file_path}"}
    except Exception as e:
        logger.error("Mistral transcription failed: %s", e, exc_info=True)
        return {"success": False, "transcript": "", "error": f"Mistral transcription failed: {type(e).__name__}"}


# ---------------------------------------------------------------------------
# Provider: xAI (Grok STT API)
# ---------------------------------------------------------------------------


def _transcribe_xai(file_path: str, model_name: str) -> Dict[str, Any]:
    """Transcribe using xAI Grok STT API.

    Uses the ``POST /v1/stt`` REST endpoint with multipart/form-data.
    Supports Inverse Text Normalization, diarization, and word-level timestamps.
    Requires ``XAI_API_KEY`` environment variable.
    """
    from tools.xai_http import resolve_xai_http_credentials

    creds = resolve_xai_http_credentials()
    api_key = str(creds.get("api_key") or "").strip()
    if not api_key:
        return {
            "success": False,
            "transcript": "",
            "error": "No xAI credentials found. Configure xAI OAuth in `hermes model` or set XAI_API_KEY",
        }

    stt_config = _load_stt_config()
    xai_config = stt_config.get("xai", {})
    base_url = str(
        xai_config.get("base_url")
        or get_env_value("XAI_STT_BASE_URL")
        or creds.get("base_url")
        or XAI_STT_BASE_URL
    ).strip().rstrip("/")
    language = str(
        xai_config.get("language")
        or os.getenv("HERMES_LOCAL_STT_LANGUAGE")
        or DEFAULT_LOCAL_STT_LANGUAGE
    ).strip()
    # .get("format", True) already defaults to True when the key is absent;
    # is_truthy_value only normalizes truthy/falsy strings from config.
    use_format = is_truthy_value(xai_config.get("format", True))
    use_diarize = is_truthy_value(xai_config.get("diarize", False))

    try:
        import requests
        from tools.xai_http import hermes_xai_user_agent

        data: Dict[str, str] = {}
        if language:
            data["language"] = language
        if use_format:
            data["format"] = "true"
        if use_diarize:
            data["diarize"] = "true"

        with open(file_path, "rb") as audio_file:
            response = requests.post(
                f"{base_url}/stt",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": hermes_xai_user_agent(),
                },
                files={
                    "file": (Path(file_path).name, audio_file),
                },
                data=data,
                timeout=120,
            )

        if response.status_code != 200:
            detail = ""
            try:
                err_body = response.json()
                detail = err_body.get("error", {}).get("message", "") or response.text[:300]
            except Exception:
                detail = response.text[:300]
            return {
                "success": False,
                "transcript": "",
                "error": f"xAI STT API error (HTTP {response.status_code}): {detail}",
            }

        result = response.json()
        transcript_text = result.get("text", "").strip()

        if not transcript_text:
            return {
                "success": False,
                "transcript": "",
                "error": "xAI STT returned empty transcript",
            }

        logger.info(
            "Transcribed %s via xAI Grok STT (lang=%s, %.1fs audio, %d chars)",
            Path(file_path).name,
            result.get("language", language),
            result.get("duration", 0),
            len(transcript_text),
        )

        return {"success": True, "transcript": transcript_text, "provider": "xai"}

    except PermissionError:
        return {"success": False, "transcript": "", "error": f"Permission denied: {file_path}"}
    except Exception as e:
        logger.error("xAI STT transcription failed: %s", e, exc_info=True)
        return {"success": False, "transcript": "", "error": f"xAI STT transcription failed: {e}"}


# ---------------------------------------------------------------------------
# Provider: paraformer (DashScope / Qwen — cloud, China-friendly)
# ---------------------------------------------------------------------------


def _resolve_paraformer_api_key(stt_config: Optional[dict] = None) -> str:
    """Return a DashScope API key from config or env, or empty string."""
    if stt_config is None:
        stt_config = _load_stt_config()
    paraformer_cfg = stt_config.get("paraformer", {})
    key = (paraformer_cfg.get("api_key") or "").strip()
    if key:
        return key
    env_key = (get_env_value("DASHSCOPE_API_KEY") or "").strip()
    return env_key


def _convert_to_wav_if_needed(file_path: str) -> tuple[str, bool]:
    """Convert non-standard audio formats (.silk, .amr, .opus) to .wav via ffmpeg.

    Returns ``(path_to_use, was_converted)``. If conversion fails or ffmpeg is
    missing, returns the original path and ``False`` so the caller can try to
    upload the raw file anyway.
    """
    suffix = Path(file_path).suffix.lower()
    if suffix not in _NONSTANDARD_AUDIO_FORMATS:
        return file_path, False

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        logger.warning(
            "Audio file %s is in %s format but ffmpeg is not installed; "
            "sending raw file to cloud STT (may be rejected)",
            file_path, suffix,
        )
        return file_path, False

    out_path = tempfile.mktemp(suffix=".wav", prefix="hermes_stt_")
    try:
        result = subprocess.run(
            [ffmpeg, "-y", "-i", file_path, "-ar", "16000", "-ac", "1", out_path],
            capture_output=True, timeout=120, text=True,
        )
        if result.returncode != 0:
            logger.warning(
                "ffmpeg failed to convert %s to wav: %s",
                file_path, result.stderr[:300],
            )
            try:
                os.unlink(out_path)
            except OSError:
                pass
            return file_path, False
        logger.info("Converted %s → %s via ffmpeg", file_path, out_path)
        return out_path, True
    except subprocess.TimeoutExpired:
        logger.warning("ffmpeg timed out converting %s", file_path)
        try:
            os.unlink(out_path)
        except OSError:
            pass
        return file_path, False
    except Exception as e:
        logger.warning("ffmpeg conversion error for %s: %s", file_path, e)
        try:
            os.unlink(out_path)
        except OSError:
            pass
        return file_path, False


def _split_audio_into_chunks(file_path: str, chunk_duration_sec: int = 600) -> list[str]:
    """Split audio file into chunks of specified duration using ffmpeg.

    Args:
        file_path: Path to the audio file
        chunk_duration_sec: Duration of each chunk in seconds (default 10 minutes)

    Returns:
        List of chunk file paths. Caller is responsible for cleanup.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found, cannot split audio")

    # Get audio duration using ffprobe
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe not found, cannot get audio duration")

    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffprobe failed: {result.stderr}")
        duration_sec = float(result.stdout.strip())
    except Exception as e:
        logger.warning("Failed to get audio duration: %s", e)
        # Fallback: assume 20 minutes
        duration_sec = 1200

    num_chunks = int(duration_sec // chunk_duration_sec) + (1 if duration_sec % chunk_duration_sec else 0)

    if num_chunks <= 1:
        return [file_path]

    logger.info("Splitting audio into %d chunks (%d sec each): %s",
                num_chunks, chunk_duration_sec, file_path)

    chunks = []
    for i in range(num_chunks):
        start = i * chunk_duration_sec
        chunk_path = tempfile.mktemp(suffix=Path(file_path).suffix, prefix=f"hermes_stt_chunk_{i}_")

        try:
            result = subprocess.run(
                [ffmpeg, "-y", "-i", file_path, "-ss", str(start),
                 "-t", str(chunk_duration_sec), "-acodec", "copy", chunk_path],
                capture_output=True, timeout=60,
            )
            if result.returncode != 0:
                # Fallback: re-encode instead of copy
                result = subprocess.run(
                    [ffmpeg, "-y", "-i", file_path, "-ss", str(start),
                     "-t", str(chunk_duration_sec), chunk_path],
                    capture_output=True, timeout=120,
                )
                if result.returncode != 0:
                    raise RuntimeError(f"ffmpeg split failed: {result.stderr[:300]}")

            chunks.append(chunk_path)
            logger.info("Created chunk %d/%d: %s", i + 1, num_chunks, chunk_path)

        except subprocess.TimeoutExpired:
            logger.error("ffmpeg timed out splitting chunk %d", i)
            # Cleanup already created chunks
            for chunk in chunks:
                try:
                    os.unlink(chunk)
                except OSError:
                    pass
            raise

    return chunks


def _submit_asr_task_async(audio_path: str, api_key: str, model_name: str) -> str:
    """Submit an async DashScope ASR task. Returns task_id or raises an exception.

    The sync MultiModalConversation API only supports ~1 minute audio. The async
    variant (with X-DashScope-Async: enable header) supports up to 4 hours.
    """
    import base64
    import httpx

    with open(audio_path, "rb") as f:
        audio_bytes = f.read()

    ext = Path(audio_path).suffix.lower()
    mime_map = {
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
        ".ogg": "audio/ogg", ".flac": "audio/flac", ".webm": "audio/webm",
        ".amr": "audio/amr", ".silk": "audio/silk", ".opus": "audio/opus",
    }
    mime_type = mime_map.get(ext, "audio/wav")
    b64_audio = base64.b64encode(audio_bytes).decode("ascii")
    audio_data_uri = f"data:{mime_type};base64,{b64_audio}"

    payload = {
        "model": model_name,
        "input": {
            "messages": [
                {"role": "system", "content": [{"text": ""}]},
                {"role": "user", "content": [{"audio": audio_data_uri}]},
            ],
        },
        "parameters": {
            "result_format": "message",
            "asr_options": {
                "enable_lid": True,
                "enable_itn": False,
            },
        },
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }

    logger.info("Submitting async ASR task: file=%s (%.1f MB), model=%s",
                Path(audio_path).name, len(audio_bytes) / (1024 * 1024), model_name)

    with httpx.Client(timeout=60) as client:
        resp = client.post(
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            headers=headers,
            json=payload,
        )

    if resp.status_code != 200:
        error_msg = resp.text[:500]
        raise RuntimeError(f"DashScope task submission HTTP {resp.status_code}: {error_msg}")

    data = resp.json()
    output = data.get("output", {})
    task_id = output.get("task_id")
    task_status = output.get("task_status")

    if not task_id:
        raise RuntimeError(f"No task_id in response. Status: {task_status}. Response: {str(data)[:500]}")

    logger.info("Async ASR task submitted: task_id=%s, status=%s", task_id, task_status)
    return task_id


def _poll_asr_task(task_id: str, api_key: str, timeout_sec: int = 1800,
                   poll_interval_sec: float = 5.0) -> str:
    """Poll a DashScope async ASR task until completion. Returns transcript text.

    Default timeout is 30 minutes (enough for multi-hour audio transcription).
    Polls every 5 seconds by default.
    """
    import httpx
    import time

    url = f"https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"
    headers = {"Authorization": f"Bearer {api_key}"}

    start_time = time.time()
    last_status = ""

    while time.time() - start_time < timeout_sec:
        time.sleep(poll_interval_sec)

        with httpx.Client(timeout=30) as client:
            resp = client.get(url, headers=headers)

        if resp.status_code != 200:
            logger.warning("Poll ASR task HTTP %s, retrying...", resp.status_code)
            continue

        data = resp.json()
        output = data.get("output", {})
        status = output.get("task_status", "UNKNOWN")

        if status != last_status:
            logger.info("ASR task %s status: %s", task_id, status)
            last_status = status

        if status in ("SUCCEEDED", "SUCCESS"):
            choices = output.get("choices", [])
            if choices:
                choice = choices[0]
                message = choice.get("message", {})
                content = message.get("content", [])
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and "text" in item:
                            return item["text"]
                elif isinstance(content, str):
                    return content

            raise RuntimeError(
                f"Task succeeded but no transcript found. Response: {str(data)[:500]}"
            )

        if status in ("FAILED", "ERROR", "CANCELED"):
            error_msg = output.get("message", "Unknown error")
            code = output.get("code", "")
            raise RuntimeError(f"Task {status}: {code} {error_msg}")

        # PENDING / RUNNING — keep polling

    raise RuntimeError(f"ASR task timed out after {timeout_sec}s (task_id={task_id})")


def _transcribe_single_chunk_async(audio_path: str, api_key: str, model_name: str) -> str:
    """Submit an async ASR task for a single chunk and poll until done."""
    task_id = _submit_asr_task_async(audio_path, api_key, model_name)
    return _poll_asr_task(task_id, api_key)


# ---------------------------------------------------------------------------
# DashScope filetrans API (for long audio via OSS upload)
# ---------------------------------------------------------------------------


def _submit_filetrans_task(audio_url: str, api_key: str, model_name: str) -> str:
    """Submit a filetrans task to DashScope for long audio transcription.

    The filetrans API requires a publicly accessible audio URL (e.g. from OSS).
    Supports audio up to 12 hours long.

    Args:
        audio_url: Public URL of the audio file (e.g. OSS signed URL).
        api_key: DashScope API key.
        model_name: Model name (should be "qwen3-asr-flash-filetrans").

    Returns:
        Task ID string.

    Raises:
        RuntimeError: If task submission fails.
    """
    import httpx

    payload = {
        "model": model_name,
        "input": {
            "file_url": audio_url,
        },
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }

    logger.info("Submitting filetrans task: model=%s, url=%s", model_name, audio_url[:100])

    with httpx.Client(timeout=60) as client:
        resp = client.post(
            "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
            headers=headers,
            json=payload,
        )

    if resp.status_code != 200:
        error_msg = resp.text[:500]
        raise RuntimeError(f"DashScope filetrans submission HTTP {resp.status_code}: {error_msg}")

    data = resp.json()
    output = data.get("output", {})
    task_id = output.get("task_id")
    task_status = output.get("task_status")

    if not task_id:
        raise RuntimeError(f"No task_id in response. Status: {task_status}. Response: {str(data)[:500]}")

    logger.info("Filetrans task submitted: task_id=%s, status=%s", task_id, task_status)
    return task_id


def _poll_filetrans_task(task_id: str, api_key: str, timeout_sec: int = 3600,
                         poll_interval_sec: float = 10.0) -> str:
    """Poll a DashScope filetrans task until completion.

    Args:
        task_id: Task ID from _submit_filetrans_task().
        api_key: DashScope API key.
        timeout_sec: Maximum wait time in seconds (default: 1 hour for long audio).
        poll_interval_sec: Polling interval in seconds (default: 10s).

    Returns:
        Transcript text.

    Raises:
        RuntimeError: If task fails or times out.
    """
    import httpx
    import time

    url = f"https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"
    headers = {"Authorization": f"Bearer {api_key}"}

    start_time = time.time()
    last_status = ""

    while time.time() - start_time < timeout_sec:
        time.sleep(poll_interval_sec)

        with httpx.Client(timeout=30) as client:
            resp = client.get(url, headers=headers)

        if resp.status_code != 200:
            logger.warning("Poll filetrans task HTTP %s, retrying...", resp.status_code)
            continue

        data = resp.json()
        output = data.get("output", {})
        status = output.get("task_status", "UNKNOWN")

        if status != last_status:
            logger.info("Filetrans task %s status: %s", task_id, status)
            last_status = status

        if status in ("SUCCEEDED", "SUCCESS"):
            # filetrans returns results via transcription_url in output.result
            result = output.get("result", {})
            transcription_url = result.get("transcription_url")

            if transcription_url:
                # Download the transcription JSON
                with httpx.Client(timeout=60) as client:
                    trans_resp = client.get(transcription_url)

                if trans_resp.status_code == 200:
                    trans_data = trans_resp.json()

                    # Extract text from transcripts
                    transcripts = trans_data.get("transcripts", [])
                    if transcripts:
                        # Concatenate all transcript texts
                        text = " ".join(t.get("text", "") for t in transcripts)
                        if text:
                            return text

                    # Fallback: try sentences
                    sentences = trans_data.get("sentences", [])
                    if sentences:
                        text = " ".join(s.get("text", "") for s in sentences)
                        if text:
                            return text

            # Fallback: try to extract from output directly
            text = output.get("text", "")
            if text:
                return text

            raise RuntimeError(
                f"Task succeeded but no transcript found. Response: {str(data)[:500]}"
            )

        if status in ("FAILED", "ERROR", "CANCELED"):
            error_msg = output.get("message", "Unknown error")
            code = output.get("code", "")
            raise RuntimeError(f"Task {status}: {code} {error_msg}")

        # PENDING / RUNNING — keep polling

    raise RuntimeError(f"Filetrans task timed out after {timeout_sec}s (task_id={task_id})")


def _upload_to_oss(audio_path: str) -> tuple[str, Optional[str]]:
    """Upload audio to user's OSS bucket and return (public_url, object_key).

    Returns:
        Tuple of (audio_url, object_key). object_key is None on failure.

    Raises:
        RuntimeError: If OSS upload fails.
    """
    from tools.oss_helper import is_oss_configured, upload_and_get_url

    if not is_oss_configured():
        raise RuntimeError("OSS not configured")

    audio_url, object_key = upload_and_get_url(audio_path)
    if not audio_url or not object_key:
        raise RuntimeError("OSS upload returned empty result")

    logger.info("Uploaded to OSS: key=%s, url=%s", object_key, audio_url[:100])
    return audio_url, object_key


def _upload_to_dashscope_files(audio_path: str, api_key: str) -> tuple[str, str]:
    """Upload audio via DashScope Files API and return (signed_url, file_id).

    Includes retry with exponential backoff on 429 rate limit errors.

    Returns:
        Tuple of (audio_url, file_id).

    Raises:
        RuntimeError: If upload fails after retries.
    """
    import time as _time

    try:
        from dashscope import Files
    except ImportError:
        raise RuntimeError(
            "dashscope package not installed. Install with: pip install dashscope"
        )

    max_retries = 3
    for attempt in range(max_retries):
        try:
            upload_result = Files.upload(audio_path, purpose='file-extract', api_key=api_key)

            if not upload_result or upload_result.status_code != 200:
                raise RuntimeError(f"Upload failed: {upload_result}")

            output = upload_result.output
            uploaded_files = output.get('uploaded_files', [])
            if not uploaded_files:
                raise RuntimeError(f"Upload failed: no files in output. Result: {upload_result}")

            file_id = uploaded_files[0]['file_id']
            logger.info("Uploaded to DashScope Files: file_id=%s", file_id)

            # Get the signed URL
            get_result = Files.get(file_id, api_key=api_key)
            if not get_result or get_result.status_code != 200:
                raise RuntimeError(f"Failed to get file URL: {get_result}")

            audio_url = get_result.output['url']

            # Convert HTTP to HTTPS (filetrans API may require HTTPS)
            if audio_url.startswith('http://'):
                audio_url = audio_url.replace('http://', 'https://', 1)

            # URL encode the URL to handle special characters in signature
            from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
            parsed = urlparse(audio_url)
            query_params = parse_qs(parsed.query)
            encoded_query = urlencode(query_params, doseq=True)
            audio_url = urlunparse((
                parsed.scheme, parsed.netloc, parsed.path,
                parsed.params, encoded_query, parsed.fragment
            ))

            logger.info("Got DashScope signed URL: %s", audio_url[:100])
            return audio_url, file_id

        except Exception as e:
            error_str = str(e)
            is_rate_limit = "429" in error_str or "Throttling" in error_str or "RateQuota" in error_str
            if is_rate_limit and attempt < max_retries - 1:
                wait_sec = 5 * (2 ** attempt)  # 5s, 10s, 20s
                logger.warning(
                    "DashScope Files API rate limited (attempt %d/%d), retrying in %ds...",
                    attempt + 1, max_retries, wait_sec,
                )
                _time.sleep(wait_sec)
                continue
            raise RuntimeError(f"Failed to upload audio to DashScope Files API: {e}")

    raise RuntimeError("DashScope Files API: max retries exceeded")


def _transcribe_single_chunk_filetrans(audio_path: str, api_key: str, model_name: str) -> str:
    """Transcribe a single chunk using filetrans API.

    Upload strategy:
    1. Try user's OSS bucket (no rate limits, fastest)
    2. Fall back to DashScope Files API (has rate limits, with retry)

    Args:
        audio_path: Path to local audio file.
        api_key: DashScope API key.
        model_name: Model name (should be "qwen3-asr-flash-filetrans").

    Returns:
        Transcript text.

    Raises:
        RuntimeError: If upload or transcription fails.
    """
    audio_url: Optional[str] = None
    oss_object_key: Optional[str] = None
    dashscope_file_id: Optional[str] = None

    # Strategy 1: Upload to user's OSS (no rate limits)
    try:
        audio_url, oss_object_key = _upload_to_oss(audio_path)
        logger.info("Using OSS upload for %s", Path(audio_path).name)
    except Exception as oss_err:
        logger.info("OSS upload unavailable (%s), falling back to DashScope Files API", oss_err)

    # Strategy 2: Upload via DashScope Files API (with retry on 429)
    if not audio_url:
        logger.info("Uploading %s via DashScope Files API...", Path(audio_path).name)
        audio_url, dashscope_file_id = _upload_to_dashscope_files(audio_path, api_key)

    try:
        # Submit filetrans task
        task_id = _submit_filetrans_task(audio_url, api_key, model_name)

        # Poll until done
        transcript = _poll_filetrans_task(task_id, api_key)
        return transcript
    finally:
        # Clean up: delete from OSS or DashScope Files
        if oss_object_key:
            try:
                from tools.oss_helper import delete_by_key
                logger.info("Deleting OSS file: %s", oss_object_key)
                delete_by_key(oss_object_key)
            except Exception as e:
                logger.warning("Failed to delete OSS file %s: %s", oss_object_key, e)
        elif dashscope_file_id:
            try:
                from dashscope import Files
                logger.info("Deleting DashScope file: %s", dashscope_file_id)
                Files.delete(dashscope_file_id, api_key=api_key)
            except Exception as e:
                logger.warning("Failed to delete DashScope file %s: %s", dashscope_file_id, e)


def _get_audio_duration_seconds(file_path: str) -> Optional[float]:
    """Get audio duration in seconds using ffprobe.

    Returns:
        Duration in seconds, or None if ffprobe is not available or fails.
    """
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None

    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except Exception:
        pass
    return None


def _transcribe_paraformer(file_path: str, model_name: str) -> Dict[str, Any]:
    """Transcribe using DashScope Qwen3 ASR API.

    Automatically chooses the best API based on audio duration and size:
    - Short audio (<=3 min, <=10MB): Use sync MultiModalConversation API
    - Long audio (>3 min or >10MB): Use filetrans API (requires OSS upload)

    For long audio without OSS configured, splits into chunks and uses async API.
    """
    from tools.oss_helper import is_oss_configured

    stt_config = _load_stt_config()
    api_key = _resolve_paraformer_api_key(stt_config)
    if not api_key:
        return {
            "success": False, "transcript": "",
            "error": "DashScope API key not set (stt.paraformer.api_key or DASHSCOPE_API_KEY)",
        }

    # Convert .silk/.amr/.opus to .wav so DashScope accepts them.
    upload_path, converted = _convert_to_wav_if_needed(file_path)

    try:
        file_size = Path(upload_path).stat().st_size
        file_size_mb = file_size / (1024 * 1024)
        duration_sec = _get_audio_duration_seconds(upload_path)

        MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10MB (DashScope limit)
        MAX_DURATION_SEC = 180  # 3 minutes (sync API limit)

        # Decide which API to use
        use_filetrans = False
        if duration_sec is not None and duration_sec > MAX_DURATION_SEC:
            use_filetrans = True
            logger.info("Audio duration %.0fs > %ds, using filetrans API", duration_sec, MAX_DURATION_SEC)
        elif file_size > MAX_SIZE_BYTES:
            use_filetrans = True
            logger.info("Audio size %.1fMB > 10MB, using filetrans API", file_size_mb)

        if use_filetrans:
            # Check if OSS is configured
            if not is_oss_configured():
                # Fallback: split into chunks and use async API
                logger.warning(
                    "OSS not configured for filetrans API. Falling back to chunked async transcription. "
                    "For better results with long audio, configure OSS: set OSS_ACCESS_KEY_ID, "
                    "OSS_ACCESS_KEY_SECRET, OSS_BUCKET_NAME, OSS_ENDPOINT in .env or config.yaml"
                )

                try:
                    chunks = _split_audio_into_chunks(upload_path, chunk_duration_sec=180)  # 3 min chunks
                except Exception as e:
                    logger.error("Failed to split audio: %s", e)
                    return {
                        "success": False, "transcript": "",
                        "error": f"Failed to split audio: {e}. For long audio, configure OSS for filetrans API.",
                    }

                if len(chunks) == 1 and chunks[0] == upload_path:
                    chunks_to_process = [upload_path]
                    cleanup_chunks = False
                else:
                    chunks_to_process = chunks
                    cleanup_chunks = True

                import time as _time

                logger.info("Transcribing %d chunks via async API", len(chunks_to_process))

                transcripts = []
                for i, chunk_path in enumerate(chunks_to_process):
                    # Delay between chunks to avoid rate limits on async API
                    if i > 0:
                        _time.sleep(3)

                    logger.info("Processing chunk %d/%d: %s (%.1f MB)",
                               i + 1, len(chunks_to_process), chunk_path,
                               Path(chunk_path).stat().st_size / (1024 * 1024))
                    try:
                        chunk_text = _transcribe_single_chunk_async(chunk_path, api_key, model_name)
                        transcripts.append(chunk_text)
                        logger.info("Chunk %d transcribed: %d chars", i + 1, len(chunk_text))
                    except Exception as e:
                        logger.error("Chunk %d transcription failed: %s", i + 1, e)
                        if cleanup_chunks:
                            for chunk in chunks_to_process:
                                try:
                                    os.unlink(chunk)
                                except OSError:
                                    pass
                        return {
                            "success": False, "transcript": "",
                            "error": f"Chunk {i + 1}/{len(chunks_to_process)} failed: {e}",
                        }

                if cleanup_chunks:
                    for chunk in chunks_to_process:
                        try:
                            os.unlink(chunk)
                        except OSError:
                            pass

                transcript_text = "\n".join(transcripts)
                logger.info("Transcribed %s via chunked async API (%d chunks, %d chars)",
                           Path(file_path).name, len(chunks_to_process), len(transcript_text))

                return {
                    "success": True, "transcript": transcript_text, "provider": "paraformer",
                }

            else:
                # OSS is configured, use filetrans API
                logger.info("Using filetrans API with OSS upload")

                if duration_sec is not None and duration_sec > MAX_DURATION_SEC:
                    # Split into chunks even for filetrans (2 min chunks for parallel processing)
                    try:
                        chunks = _split_audio_into_chunks(upload_path, chunk_duration_sec=120)
                    except Exception as e:
                        logger.error("Failed to split audio: %s", e)
                        return {
                            "success": False, "transcript": "",
                            "error": f"Failed to split audio: {e}",
                        }

                    if len(chunks) == 1 and chunks[0] == upload_path:
                        chunks_to_process = [upload_path]
                        cleanup_chunks = False
                    else:
                        chunks_to_process = chunks
                        cleanup_chunks = True

                    logger.info("Transcribing %d chunks via filetrans API", len(chunks_to_process))

                    # Use filetrans model for long audio
                    filetrans_model = "qwen3-asr-flash-filetrans"

                    import time as _time

                    transcripts = []
                    for i, chunk_path in enumerate(chunks_to_process):
                        # Small delay between chunks to avoid rate limits
                        # (only when using DashScope Files API, not OSS)
                        if i > 0 and not is_oss_configured():
                            _time.sleep(2)

                        logger.info("Processing chunk %d/%d via filetrans: %s (%.1f MB)",
                                   i + 1, len(chunks_to_process), chunk_path,
                                   Path(chunk_path).stat().st_size / (1024 * 1024))
                        try:
                            chunk_text = _transcribe_single_chunk_filetrans(
                                chunk_path, api_key, filetrans_model
                            )
                            transcripts.append(chunk_text)
                            logger.info("Chunk %d transcribed: %d chars", i + 1, len(chunk_text))
                        except Exception as e:
                            logger.error("Chunk %d filetrans failed: %s", i + 1, e)
                            if cleanup_chunks:
                                for chunk in chunks_to_process:
                                    try:
                                        os.unlink(chunk)
                                    except OSError:
                                        pass
                            return {
                                "success": False, "transcript": "",
                                "error": f"Chunk {i + 1}/{len(chunks_to_process)} filetrans failed: {e}",
                            }

                    if cleanup_chunks:
                        for chunk in chunks_to_process:
                            try:
                                os.unlink(chunk)
                            except OSError:
                                pass

                    transcript_text = "\n".join(transcripts)
                    logger.info("Transcribed %s via filetrans API (%d chunks, %d chars)",
                               Path(file_path).name, len(chunks_to_process), len(transcript_text))

                    return {
                        "success": True, "transcript": transcript_text, "provider": "paraformer",
                    }
                else:
                    # Single file, use filetrans directly
                    filetrans_model = "qwen3-asr-flash-filetrans"
                    logger.info("Transcribing %s (%.1f MB) via filetrans API",
                               Path(file_path).name, file_size_mb)

                    transcript_text = _transcribe_single_chunk_filetrans(
                        upload_path, api_key, filetrans_model
                    )

                    logger.info("Transcribed %s via filetrans API (%d chars)",
                               Path(file_path).name, len(transcript_text))

                    return {
                        "success": True, "transcript": transcript_text, "provider": "paraformer",
                    }

        else:
            # Short audio, use sync MultiModalConversation API
            logger.info("Audio is short (%.0fs, %.1fMB), using sync API",
                       duration_sec or 0, file_size_mb)

            import base64
            import httpx

            with open(upload_path, "rb") as f:
                audio_bytes = f.read()

            ext = Path(upload_path).suffix.lower()
            mime_map = {
                ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
                ".ogg": "audio/ogg", ".flac": "audio/flac", ".webm": "audio/webm",
                ".amr": "audio/amr", ".silk": "audio/silk", ".opus": "audio/opus",
            }
            mime_type = mime_map.get(ext, "audio/wav")
            b64_audio = base64.b64encode(audio_bytes).decode("ascii")
            audio_data_uri = f"data:{mime_type};base64,{b64_audio}"

            payload = {
                "model": model_name,
                "input": {
                    "messages": [
                        {"role": "system", "content": [{"text": ""}]},
                        {"role": "user", "content": [{"audio": audio_data_uri}]},
                    ],
                },
                "parameters": {
                    "result_format": "message",
                    "asr_options": {
                        "enable_lid": True,
                        "enable_itn": False,
                    },
                },
            }

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }

            with httpx.Client(timeout=120) as client:
                resp = client.post(
                    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
                    headers=headers,
                    json=payload,
                )

            if resp.status_code != 200:
                error_msg = resp.text[:500]
                logger.error("DashScope sync API HTTP %s: %s", resp.status_code, error_msg)
                return {
                    "success": False, "transcript": "",
                    "error": f"DashScope API HTTP {resp.status_code}: {error_msg}",
                }

            data = resp.json()
            output = data.get("output", {})
            choices = output.get("choices", [])
            transcript_text = ""

            if choices:
                choice = choices[0]
                message = choice.get("message", {})
                content = message.get("content", [])
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and "text" in item:
                            transcript_text = item["text"]
                            break
                elif isinstance(content, str):
                    transcript_text = content

            if not transcript_text:
                logger.warning("DashScope sync API returned empty transcript. Response: %s",
                              str(data)[:500])
                return {
                    "success": False, "transcript": "",
                    "error": "DashScope API returned empty transcript",
                }

            logger.info("Transcribed %s via sync API (%s, %d chars)",
                       Path(file_path).name, model_name, len(transcript_text))

            return {
                "success": True, "transcript": transcript_text, "provider": "paraformer",
            }

    except PermissionError:
        return {"success": False, "transcript": "", "error": f"Permission denied: {file_path}"}
    except Exception as e:
        logger.error("Paraformer transcription failed: %s", e, exc_info=True)
        return {"success": False, "transcript": "", "error": f"Paraformer transcription failed: {e}"}
    finally:
        if converted and upload_path != file_path:
            try:
                os.unlink(upload_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def transcribe_audio(file_path: str, model: Optional[str] = None) -> Dict[str, Any]:
    """
    Transcribe an audio file using the configured STT provider.

    Provider priority:
      1. User config (``stt.provider`` in config.yaml)
      2. Auto-detect: local faster-whisper (free) > Groq (free tier) > OpenAI (paid)

    Args:
        file_path: Absolute path to the audio file to transcribe.
        model:     Override the model. If None, uses config or provider default.

    Returns:
        dict with keys:
          - "success" (bool): Whether transcription succeeded
          - "transcript" (str): The transcribed text (empty on failure)
          - "error" (str, optional): Error message if success is False
          - "provider" (str, optional): Which provider was used
    """
    # Validate input
    error = _validate_audio_file(file_path)
    if error:
        return error

    # Load config and determine provider
    stt_config = _load_stt_config()
    if not is_stt_enabled(stt_config):
        return {
            "success": False,
            "transcript": "",
            "error": "STT is disabled in config.yaml (stt.enabled: false).",
        }

    provider = _get_provider(stt_config)

    if provider == "local":
        local_cfg = stt_config.get("local", {})
        model_name = _normalize_local_model(
            model or local_cfg.get("model", DEFAULT_LOCAL_MODEL)
        )
        return _transcribe_local(file_path, model_name)

    if provider == "local_command":
        local_cfg = stt_config.get("local", {})
        model_name = _normalize_local_command_model(
            model or local_cfg.get("model", DEFAULT_LOCAL_MODEL)
        )
        return _transcribe_local_command(file_path, model_name)

    if provider == "groq":
        model_name = model or DEFAULT_GROQ_STT_MODEL
        return _transcribe_groq(file_path, model_name)

    if provider == "openai":
        openai_cfg = stt_config.get("openai", {})
        model_name = model or openai_cfg.get("model", DEFAULT_STT_MODEL)
        return _transcribe_openai(file_path, model_name)

    if provider == "mistral":
        mistral_cfg = stt_config.get("mistral", {})
        model_name = model or mistral_cfg.get("model", DEFAULT_MISTRAL_STT_MODEL)
        return _transcribe_mistral(file_path, model_name)

    if provider == "xai":
        # xAI Grok STT doesn't use a model parameter — pass through for logging
        model_name = model or "grok-stt"
        return _transcribe_xai(file_path, model_name)

    if provider == "paraformer":
        paraformer_cfg = stt_config.get("paraformer", {})
        model_name = model or paraformer_cfg.get("model", DEFAULT_PARAFORMER_STT_MODEL)
        return _transcribe_paraformer(file_path, model_name)

    # No provider available
    return {
        "success": False,
        "transcript": "",
        "error": (
            "No STT provider available. Install faster-whisper for free local "
            f"transcription, configure {LOCAL_STT_COMMAND_ENV} or install a local whisper CLI, "
            "set GROQ_API_KEY for free Groq Whisper, set MISTRAL_API_KEY for Mistral "
            "Voxtral Transcribe, configure xAI OAuth or set XAI_API_KEY for xAI Grok STT, "
            "set DASHSCOPE_API_KEY for DashScope Paraformer, or set VOICE_TOOLS_OPENAI_KEY "
            "or OPENAI_API_KEY for the OpenAI Whisper API."
        ),
    }


def _resolve_openai_audio_client_config() -> tuple[str, str]:
    """Return direct OpenAI audio config or a managed gateway fallback."""
    stt_config = _load_stt_config()
    openai_cfg = stt_config.get("openai", {})
    cfg_api_key = openai_cfg.get("api_key", "")
    cfg_base_url = openai_cfg.get("base_url", "")
    if cfg_api_key:
        return cfg_api_key, (cfg_base_url or OPENAI_BASE_URL)

    direct_api_key = resolve_openai_audio_api_key()
    if direct_api_key:
        return direct_api_key, OPENAI_BASE_URL

    managed_gateway = resolve_managed_tool_gateway("openai-audio")
    if managed_gateway is None:
        message = "Neither stt.openai.api_key in config nor VOICE_TOOLS_OPENAI_KEY/OPENAI_API_KEY is set"
        if managed_nous_tools_enabled():
            message += ", and the managed OpenAI audio gateway is unavailable"
        raise ValueError(message)

    return managed_gateway.nous_user_token, urljoin(
        f"{managed_gateway.gateway_origin.rstrip('/')}/", "v1"
    )


def _extract_transcript_text(transcription: Any) -> str:
    """Normalize text and JSON transcription responses to a plain string."""
    if isinstance(transcription, str):
        return transcription.strip()

    if hasattr(transcription, "text"):
        value = getattr(transcription, "text")
        if isinstance(value, str):
            return value.strip()

    if isinstance(transcription, dict):
        value = transcription.get("text")
        if isinstance(value, str):
            return value.strip()

    return str(transcription).strip()
