import { randomUUID } from "node:crypto";

export type GoalStatus = "active" | "paused" | "review" | "completed" | "cancelled";
export interface GoalReport {
	progress: string;
	nextAction?: string;
	evidence: string[];
	readyForReview: boolean;
}
export interface GoalState {
	id: string;
	revision: number;
	objective: string;
	status: GoalStatus;
	maxRuns: number;
	usedRuns: number;
	noProgressRuns: number;
	progress: string;
	nextAction: string;
	evidence: string[];
	runToken?: string;
	report?: GoalReport;
	reason?: string;
}
export function readGoal(value: unknown): GoalState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const goal = value as Partial<GoalState>;
	if (
		typeof goal.id !== "string" ||
		!goal.id ||
		typeof goal.objective !== "string" ||
		!goal.objective.trim() ||
		!Number.isSafeInteger(goal.revision) ||
		(goal.revision ?? 0) < 1 ||
		!["active", "paused", "review", "completed", "cancelled"].includes(goal.status ?? "") ||
		!Number.isSafeInteger(goal.maxRuns) ||
		(goal.maxRuns ?? 0) < 1 ||
		!Number.isSafeInteger(goal.usedRuns) ||
		(goal.usedRuns ?? -1) < 0 ||
		!Number.isSafeInteger(goal.noProgressRuns) ||
		(goal.noProgressRuns ?? -1) < 0 ||
		typeof goal.progress !== "string" ||
		typeof goal.nextAction !== "string" ||
		!Array.isArray(goal.evidence) ||
		!goal.evidence.every((item) => typeof item === "string") ||
		(goal.runToken !== undefined && typeof goal.runToken !== "string")
	)
		return undefined;
	return structuredClone(goal as GoalState);
}

/** A bounded goal driver. Only a human command or a trusted verifier can accept completion. */
export class GoalController {
	private goal: GoalState | undefined;
	private readonly persist: (state: GoalState | undefined) => void;
	constructor(persist: (state: GoalState | undefined) => void) {
		this.persist = persist;
	}
	get state(): GoalState | undefined {
		return this.goal ? structuredClone(this.goal) : undefined;
	}
	private save(next: GoalState | undefined): void {
		this.persist(next ? structuredClone(next) : undefined);
		this.goal = next;
	}
	/** Branch-local restore is always passive; an interrupted dispatch requires explicit resume. */
	restore(value: unknown): void {
		this.goal = undefined;
		const restored = readGoal(value);
		if (value != null && !restored) throw new Error("Invalid goal state; automatic execution refused");
		if (restored?.status === "active") {
			restored.status = "paused";
			restored.reason = "Restored session; explicit /goal resume required";
			restored.revision++;
		}
		if (restored) {
			delete restored.runToken;
			delete restored.report;
		}
		this.goal = restored;
	}
	create(objective: string, maxRuns = 20): GoalState {
		if (this.goal && !["completed", "cancelled"].includes(this.goal.status))
			throw new Error("Pause/clear the current goal first");
		if (!objective.trim() || objective.length > 16_000 || !Number.isSafeInteger(maxRuns) || maxRuns < 1) {
			throw new Error("Invalid goal or run budget");
		}
		this.save({
			id: randomUUID(),
			revision: 1,
			objective: objective.trim(),
			status: "active",
			maxRuns,
			usedRuns: 0,
			noProgressRuns: 0,
			progress: "",
			nextAction: "Inspect the project and establish acceptance evidence.",
			evidence: [],
		});
		return this.state as GoalState;
	}
	private required(): GoalState {
		if (!this.goal) throw new Error("No goal is selected");
		return structuredClone(this.goal);
	}
	dispatch(): { token: string; prompt: string } | undefined {
		const next = this.required();
		if (next.status !== "active" || next.runToken) return undefined;
		if (next.usedRuns >= next.maxRuns) {
			this.pause("Autonomous run budget exhausted");
			return undefined;
		}
		next.usedRuns++;
		next.revision++;
		next.runToken = randomUUID();
		delete next.report;
		this.save(next);
		return {
			token: next.runToken,
			prompt: [
				"Continue the authorized goal; do not widen its scope or permissions.",
				`Objective: ${next.objective}`,
				`Next action: ${next.nextAction}`,
				`Run token: ${next.runToken}`,
				"Use pi861_goal_report with this token, concrete progress and evidence references.",
				"Report readyForReview only when the stated requirements are satisfied; human acceptance is separate.",
				"Pause and report missing input rather than guessing or repeating ineffective work.",
			].join("\n"),
		};
	}
	report(token: string, report: GoalReport): void {
		const next = this.required();
		if (next.status !== "active" || next.runToken !== token) throw new Error("Stale goal run");
		if (
			!report.progress.trim() ||
			report.progress.length > 4000 ||
			(report.nextAction?.length ?? 0) > 4000 ||
			report.evidence.length > 50 ||
			report.evidence.some((item) => !item.trim() || item.length > 2000)
		)
			throw new Error("Invalid progress report");
		if (report.readyForReview && report.evidence.length === 0) throw new Error("Review requires evidence");
		next.report = structuredClone(report);
		next.revision++;
		this.save(next);
	}
	settle(token: string, outcome: "ok" | "error" | "aborted"): boolean {
		const next = this.required();
		if (next.status !== "active" || next.runToken !== token) return false;
		delete next.runToken;
		next.revision++;
		if (outcome !== "ok") {
			next.status = "paused";
			next.reason = outcome === "aborted" ? "Execution cancelled" : "Execution failed; inspect before resuming";
		} else {
			const report = next.report;
			const changed =
				report &&
				(report.progress !== next.progress || report.evidence.some((item) => !next.evidence.includes(item)));
			next.noProgressRuns = changed ? 0 : next.noProgressRuns + 1;
			if (report) {
				next.progress = report.progress;
				next.evidence = [...new Set([...next.evidence, ...report.evidence])].slice(-100);
				next.nextAction = report.nextAction?.trim() ?? "";
				if (report.readyForReview) {
					next.status = "review";
					next.reason = "Awaiting independent or human acceptance";
				} else if (!next.nextAction) {
					next.status = "paused";
					next.reason = "No safe next action was declared";
				}
			}
			if (next.status === "active" && next.noProgressRuns >= 2) {
				next.status = "paused";
				next.reason = "No verifiable progress report in two runs";
			}
			if (next.status === "active" && next.usedRuns >= next.maxRuns) {
				next.status = "paused";
				next.reason = "Autonomous run budget exhausted";
			}
		}
		delete next.report;
		this.save(next);
		return next.status === "active";
	}
	pause(reason = "Paused by user"): void {
		const next = this.required();
		if (next.status === "completed" || next.status === "cancelled") return;
		next.status = "paused";
		next.reason = reason;
		next.revision++;
		delete next.runToken;
		delete next.report;
		this.save(next);
	}
	resume(): void {
		const next = this.required();
		if (next.status !== "paused") throw new Error("Only a paused goal can resume");
		if (next.usedRuns >= next.maxRuns) throw new Error("Run budget exhausted; explicitly raise /goal budget first");
		next.status = "active";
		next.noProgressRuns = 0;
		next.revision++;
		delete next.reason;
		this.save(next);
	}
	setBudget(maxRuns: number): void {
		const next = this.required();
		if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) throw new Error("Invalid run budget");
		next.maxRuns = maxRuns;
		next.revision++;
		// Never replenish usedRuns. Changing a limit does not resume or create work.
		this.save(next);
	}
	edit(objective: string): void {
		const next = this.required();
		if (next.status !== "paused" || !objective.trim() || objective.length > 16_000) {
			throw new Error("Pause before editing; a non-empty objective is required");
		}
		next.objective = objective.trim();
		next.nextAction = "Reconcile the revised objective with completed work before continuing.";
		next.revision++;
		this.save(next);
	}
	accept(): void {
		const next = this.required();
		if (next.status !== "review" || next.evidence.length === 0) throw new Error("Goal is not ready for acceptance");
		next.status = "completed";
		next.revision++;
		delete next.reason;
		this.save(next);
	}
	clear(): void {
		const next = this.required();
		next.status = "cancelled";
		next.revision++;
		delete next.runToken;
		delete next.report;
		this.save(next);
	}
}
