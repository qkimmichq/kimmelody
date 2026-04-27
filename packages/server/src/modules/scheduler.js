import cron from 'node-cron';

export class Scheduler {
  constructor({ state, onTrigger }) {
    this.state = state;
    this.onTrigger = onTrigger;
    this.tasks = [];
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    const rules = this.state.getEnabledRules();
    for (const rule of rules) {
      this._schedule(rule);
    }
    console.log(`[Scheduler] 已启动 ${this.tasks.length} 个定时任务`);
  }

  stop() {
    this.tasks.forEach(t => t.task.stop());
    this.tasks = [];
    this.running = false;
  }

  reload() {
    this.stop();
    this.start();
  }

  _schedule(rule) {
    // 验证 cron 表达式
    if (!cron.validate(rule.cron)) {
      console.warn(`[Scheduler] 无效 cron 表达式: ${rule.cron} (${rule.name})`);
      return;
    }

    const task = cron.schedule(rule.cron, () => {
      console.log(`[Scheduler] ▶ 触发: ${rule.name} (${rule.scene})`);

      // 检查当前是否有活跃会话，避免中断用户手动播放
      const session = this.state.getCurrentSession();
      if (session?.isPlaying && rule.scene === 'mood_check') {
        // 情绪检查可以后台执行
      }

      const trigger = {
        type: 'scheduled',
        scene: rule.scene,
        name: rule.name,
        config: rule.config ? JSON.parse(rule.config) : {},
        device: this.state.getActiveDevice(),
      };

      this.onTrigger(trigger).catch(err => {
        console.error(`[Scheduler] 任务执行失败: ${rule.name}`, err.message);
      });
    }, {
      scheduled: true,
      timezone: 'Asia/Shanghai',
    });

    this.tasks.push({ rule, task });
  }

  // 手动触发一个场景
  async triggerScene(scene) {
    console.log(`[Scheduler] 手动触发场景: ${scene}`);
    await this.onTrigger({
      type: 'manual',
      scene,
      device: this.state.getActiveDevice(),
    });
  }
}
