/** Reminder presentation retained from CFL; the shared backend capability is not connected yet. */
export type AlarmView = {
  id: string;
  message: string;
  schedule:
    | { kind: "once"; at: string }
    | { kind: "interval"; everyMinutes: number }
    | { kind: "daily"; hour: number; minute: number; timeZone: string }
    | {
        kind: "weekly";
        hour: number;
        minute: number;
        timeZone: string;
        weekday: number;
      };
  nextAt: number;
};
