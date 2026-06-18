export interface ScheduledTask {
  cancel(): void;
}

export interface Scheduler {
  schedule(delaySeconds: number, callback: () => void): ScheduledTask;
}

export const systemScheduler: Scheduler = {
  schedule(delaySeconds: number, callback: () => void): ScheduledTask {
    const timeout = setTimeout(callback, Math.max(0, delaySeconds) * 1000);
    timeout.unref?.();
    return {
      cancel(): void {
        clearTimeout(timeout);
      },
    };
  },
};

interface FakeScheduledTask extends ScheduledTask {
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class FakeScheduler implements Scheduler {
  private nowSeconds = 0;
  private readonly tasks: FakeScheduledTask[] = [];

  schedule(delaySeconds: number, callback: () => void): ScheduledTask {
    const task: FakeScheduledTask = {
      dueAt: this.nowSeconds + Math.max(0, delaySeconds),
      callback,
      cancelled: false,
      cancel(): void {
        task.cancelled = true;
      },
    };
    this.tasks.push(task);
    return task;
  }

  advance(seconds: number): void {
    this.nowSeconds += Math.max(0, seconds);
    this.runDueTasks();
  }

  pendingCount(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }

  private runDueTasks(): void {
    while (true) {
      const task = this.tasks
        .filter((candidate) => !candidate.cancelled && candidate.dueAt <= this.nowSeconds)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!task) return;
      task.cancelled = true;
      task.callback();
    }
  }
}
