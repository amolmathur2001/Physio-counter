"""Claude-powered helpers: reading physio prescriptions and understanding free-form voice commands."""

from typing import Literal

import anthropic
from pydantic import BaseModel, Field

MODEL = "claude-opus-5-5"
# On a safety-classifier refusal the API re-runs the request on a suitable fallback model.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AIUnavailable(Exception):
    """No credentials, or the API could not be reached."""


class AIError(Exception):
    """The API answered but gave nothing usable."""


class Exercise(BaseModel):
    name: str
    reps: int = Field(description="Target count per set")
    sets: int
    count_seconds: float = Field(description="Seconds per count (tempo of the movement)")
    hold_seconds: float = Field(description="Hold at the end of each rep; 0 if none")
    rest_seconds: float = Field(description="Rest between sets")
    side: Literal["left", "right", "both", "each", "none"]
    notes: str = Field(description="Physio instructions and cautions, plus which values were assumed")


class Prescription(BaseModel):
    exercises: list[Exercise]


class VoiceCommand(BaseModel):
    action: Literal[
        "start", "pause", "resume", "stop", "restart", "next_set", "skip_rest",
        "change_tempo", "change_target", "repeat_count", "none",
    ]
    value: float | None = Field(description="New seconds per count, or new target count; null otherwise")
    say: str = Field(description="Short spoken confirmation, empty for action none")


PRESCRIPTION_SYSTEM = """\
You read physiotherapy home-exercise prescriptions (typed notes, or photos of printed or handwritten \
sheets) and turn each exercise into settings for a voice rep counter.

- Copy reps, sets, hold times and rest exactly as written. Never add exercises or change a dose.
- Shorthand: "3x10" = 3 sets of 10 reps; "hold 5s" = hold_seconds 5; SLR = straight leg raise; \
B/L = both legs; R / L = right / left; "each leg" = side "each".
- If a value is not given, use count_seconds 2, hold_seconds 0, rest_seconds 30, sets 1, and say in \
notes which values you assumed so the patient can confirm them with their physio.
- Put cautions such as "stop if painful" in notes.
- If the input is not an exercise prescription, return an empty exercises list."""

COMMAND_SYSTEM = """\
You interpret what a patient says to a hands-free rep counter while doing physiotherapy exercises. \
Map the speech to exactly one action, using the current counter state you are given.

- change_tempo: value is the new seconds per count ("slower" means about 0.5-1 more than now).
- change_target: value is the new target count per set.
- repeat_count: the patient wants to know where they are; put the current count in say.
- stop ends the session; pause keeps the place. If unsure between them, choose pause.
- If the patient mentions pain, dizziness or feeling unwell: action pause, and say to rest and \
check with their physio.
- Speech that is not meant for the counter (conversation, TV, the counter's own voice): action none.
- say is at most 8 words, in the language the patient used."""


_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        try:
            _client = anthropic.AsyncAnthropic()
        except anthropic.AnthropicError as e:
            raise AIUnavailable("AI is not configured on the server (set ANTHROPIC_API_KEY).") from e
    return _client


async def _parse(system: str, content: list[dict], schema: type[BaseModel], effort: str):
    try:
        response = await _get_client().beta.messages.parse(
            model=MODEL,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": content}],
            output_format=schema,
            output_config={"effort": effort},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
    except TypeError as e:
        # Raised by the SDK at request time when no credentials are configured at all.
        if "authentication" not in str(e):
            raise
        raise AIUnavailable("AI is not configured on the server (set ANTHROPIC_API_KEY).") from e
    except anthropic.AuthenticationError as e:
        raise AIUnavailable("AI key on the server is missing or invalid.") from e
    except anthropic.RateLimitError as e:
        raise AIUnavailable("AI is busy right now, try again in a moment.") from e
    except anthropic.APIConnectionError as e:
        raise AIUnavailable("Could not reach the AI service.") from e
    except anthropic.APIStatusError as e:
        raise AIError(f"AI request failed ({e.status_code}).") from e

    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise AIError("AI could not handle that input.")
    return response.parsed_output


async def read_prescription(content: list[dict]) -> Prescription:
    return await _parse(PRESCRIPTION_SYSTEM, content, Prescription, effort="medium")


async def interpret_command(transcript: str, state: dict) -> VoiceCommand:
    text = f"Counter state: {state}\nPatient said: {transcript!r}"
    # Low effort keeps the reply fast; common commands never reach here (matched on the phone).
    return await _parse(COMMAND_SYSTEM, [{"type": "text", "text": text}], VoiceCommand, effort="low")
