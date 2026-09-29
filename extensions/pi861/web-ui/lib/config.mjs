export const config = {
  port: Number(process.env.PORT) || 3900,
  host: process.env.HOST || "0.0.0.0",
  stateDir:
    process.env.PI861_STATE_DIR || "/mnt/d/pi-projects/android-app/.pi861-state",
  pollMs: 2000,
};
