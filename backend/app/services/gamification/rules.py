"""Gamification rules as data. Tweak numbers here."""

from dataclasses import dataclass

# XP per activity kind. Kinds not listed earn nothing.
XP_RULES: dict[str, int] = {
    "issue_opened": 5,
    "issue_closed": 20,
    "pr_opened": 10,
    "pr_merged": 50,
    "pr_approved": 5,
    "review_submitted": 15,
    "task_succeeded": 5,
    "kudos": 25,
}
XP_PER_COMMIT = 2
XP_PUSH_CAP = 20

# Morale deltas per activity kind (morale is 0..100).
MORALE_RULES: dict[str, int] = {
    "pr_merged": 4,
    "pr_approved": 2,
    "pr_changes_requested": -3,
    "review_submitted": 1,
    "task_succeeded": 1,
    "task_failed": -4,
    "kudos": 10,
    "one_on_one": 3,
    "criticism": -8,
}
MORALE_BASELINE = 70
# Morale drops (negative deltas, incl. overwork) only apply this fraction, so it depletes slowly.
MORALE_DROP_SCALE = 0.25
MORALE_DAILY_DRIFT = 5
OVERWORK_TASKS_PER_DAY = 15
OVERWORK_PENALTY = 2


def xp_threshold(level: int) -> int:
    """Total XP required to reach `level` (level 1 starts at 0)."""
    return round(100 * (level - 1) ** 1.5)


def level_for_xp(xp: int) -> int:
    level = 1
    while xp >= xp_threshold(level + 1):
        level += 1
    return level


def morale_band(morale: int) -> str:
    if morale >= 85:
        return "thriving"
    if morale >= 65:
        return "motivated"
    if morale >= 45:
        return "steady"
    if morale >= 25:
        return "frustrated"
    return "burned out"


@dataclass(frozen=True)
class Achievement:
    key: str
    name: str
    description: str
    icon: str  # icon name understood by the frontend
    stat: str  # which counter to compare
    threshold: int


ACHIEVEMENTS: list[Achievement] = [
    Achievement("first_merge", "First Merge", "Got a pull request merged.", "git-merge", "pr_merged", 1),
    Achievement("merge_machine", "Merge Machine", "10 pull requests merged.", "rocket", "pr_merged", 10),
    Achievement("first_review", "Fresh Eyes", "Submitted a first code review.", "eye", "review_submitted", 1),
    Achievement("review_guru", "Review Guru", "25 code reviews submitted.", "glasses", "review_submitted", 25),
    Achievement("bug_slayer", "Bug Slayer", "Closed 10 issues.", "bug", "issue_closed", 10),
    Achievement("planner", "Planner", "Opened 10 issues.", "list-todo", "issue_opened", 10),
    Achievement("committed", "Committed", "Pushed 100 commits.", "git-commit", "commits", 100),
    Achievement("crowd_favorite", "Crowd Favorite", "Received 5 kudos from the manager.", "heart", "kudos", 5),
    Achievement("workhorse", "Workhorse", "Completed 50 tasks.", "dumbbell", "task_succeeded", 50),
    Achievement("level_5", "Senior", "Reached level 5.", "star", "level", 5),
    Achievement("level_10", "Principal", "Reached level 10.", "crown", "level", 10),
]
ACHIEVEMENTS_BY_KEY = {a.key: a for a in ACHIEVEMENTS}

# Activity kinds that are themselves gamification output — never re-processed.
META_KINDS = {"level_up", "achievement_unlocked", "morale_changed"}

TRAITS: dict[str, str] = {
    "meticulous": "You are meticulous: you double-check edge cases and write thorough tests.",
    "fast": "You value speed: you ship small, incremental changes quickly.",
    "cautious": "You are cautious: you ask clarifying questions before making risky changes.",
    "chatty": "You are communicative: you keep teammates and the manager updated frequently.",
    "terse": "You are terse: your messages are short and to the point.",
    "mentor": "You are a mentor: you explain your reasoning and help teammates grow in reviews.",
    "pragmatic": "You are pragmatic: you prefer simple solutions that work over perfect ones.",
    "perfectionist": "You are a perfectionist: you care deeply about code quality and polish.",
    "creative": "You are creative: you propose novel approaches and improvements.",
    "skeptical": "You are skeptical: you challenge assumptions and look for flaws.",
}
