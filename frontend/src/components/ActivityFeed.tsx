import {
  Activity as ActivityIcon,
  ArrowUpCircle,
  CheckCircle2,
  CircleDot,
  ClipboardCheck,
  Eye,
  FileWarning,
  FolderGit2,
  FolderMinus,
  FolderPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Heart,
  Mail,
  Megaphone,
  Smile,
  ThumbsUp,
  Trophy,
  UserMinus,
  UserPlus,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { useSession } from "../App";
import { useFeatures } from "../api/queries";
import type { Activity } from "../api/types";
import { cn, dateTime, timeAgo } from "../lib/format";
import { Avatar } from "./Avatar";
import { EmptyState } from "./ui";

const KIND: Record<string, { icon: LucideIcon; color: string }> = {
  issue_opened: { icon: CircleDot, color: "#22c55e" },
  issue_closed: { icon: CheckCircle2, color: "#a855f7" },
  pr_opened: { icon: GitPullRequest, color: "#3b82f6" },
  pr_merged: { icon: GitMerge, color: "#a855f7" },
  pr_approved: { icon: ThumbsUp, color: "#22c55e" },
  pr_changes_requested: { icon: FileWarning, color: "#f97316" },
  review_submitted: { icon: Eye, color: "#06b6d4" },
  commits_pushed: { icon: GitCommitHorizontal, color: "#64748b" },
  task_succeeded: { icon: CheckCircle2, color: "#22c55e" },
  task_failed: { icon: XCircle, color: "#ef4444" },
  kudos: { icon: Heart, color: "#ec4899" },
  level_up: { icon: ArrowUpCircle, color: "#f59e0b" },
  achievement_unlocked: { icon: Trophy, color: "#f59e0b" },
  morale_changed: { icon: Smile, color: "#14b8a6" },
  hired: { icon: UserPlus, color: "#22c55e" },
  fired: { icon: UserMinus, color: "#ef4444" },
  assigned: { icon: FolderPlus, color: "#3b82f6" },
  unassigned: { icon: FolderMinus, color: "#64748b" },
  project_created: { icon: FolderGit2, color: "#7c6cff" },
  mail: { icon: Mail, color: "#7c6cff" },
  mail_sent: { icon: Mail, color: "#7c6cff" },
  review_written: { icon: ClipboardCheck, color: "#06b6d4" },
  nudge: { icon: Megaphone, color: "#f59e0b" },
};

const XP_KINDS = new Set(["level_up", "achievement_unlocked"]);
const MORALE_KINDS = new Set(["morale_changed"]);

export function kindMeta(kind: string) {
  return KIND[kind] ?? { icon: ActivityIcon, color: "#64748b" };
}

export function ActivityFeed({ items, compact, emptyText = "No activity yet.", className }: {
  items: Activity[] | undefined;
  compact?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const { agentById } = useSession();
  const features = useFeatures();
  const visible = (items ?? []).filter(
    (a) => (features.xp || !XP_KINDS.has(a.kind)) && (features.morale || !MORALE_KINDS.has(a.kind)),
  );
  if (!visible.length) {
    return <EmptyState icon={<ActivityIcon size={20} />} title="Quiet for now" description={emptyText} className="py-8" />;
  }
  return (
    <ol className={cn("relative space-y-1", className)}>
      {visible.map((a) => {
        const meta = kindMeta(a.kind);
        const agent = agentById(a.agent_id);
        const Icon = meta.icon;
        return (
          <li key={a.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
            <span className="relative mt-0.5 shrink-0">
              {agent ? (
                <Link to={`/team/${agent.id}`}>
                  <Avatar agent={agent} size={compact ? 28 : 32} dimmed={agent.status === "fired"} />
                </Link>
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-3">
                  <Icon size={15} style={{ color: meta.color }} />
                </span>
              )}
              {agent && (
                <span
                  className="absolute -right-1 -bottom-1 flex h-4.5 w-4.5 items-center justify-center rounded-full border-2 border-surface"
                  style={{ background: meta.color }}
                >
                  <Icon size={9} className="text-white" strokeWidth={3} />
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm leading-snug break-words">{a.summary || a.kind.replace(/_/g, " ")}</div>
              <div className="mt-0.5 text-xs text-subtle" title={dateTime(a.created_at)}>
                {timeAgo(a.created_at)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
