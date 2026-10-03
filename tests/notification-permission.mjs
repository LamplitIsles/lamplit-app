// Other acceptance runners must never prompt for real browser/OS permission.
export function denyNativeNotifications() {
  window.Notification = class {
    static permission = "denied";
    static requestPermission() {
      throw new Error("Unexpected notification request");
    }
    constructor() {
      throw new Error("Unexpected native notification delivery");
    }
  };
}
