import {
  Award,
  Bug,
  Crown,
  Dumbbell,
  Eye,
  GitCommitHorizontal,
  GitMerge,
  Glasses,
  Heart,
  ListTodo,
  Rocket,
  Sparkles,
  Star,
  Trophy,
  type LucideIcon,
} from "lucide-react";

/** Icon names used by backend rules.py achievements -> lucide components. */
const ICONS: Record<string, LucideIcon> = {
  "git-merge": GitMerge,
  rocket: Rocket,
  eye: Eye,
  glasses: Glasses,
  bug: Bug,
  "list-todo": ListTodo,
  "git-commit": GitCommitHorizontal,
  heart: Heart,
  dumbbell: Dumbbell,
  star: Star,
  crown: Crown,
  trophy: Trophy,
  sparkles: Sparkles,
};

export function iconFor(name: string | undefined | null): LucideIcon {
  return (name && ICONS[name]) || Award;
}
