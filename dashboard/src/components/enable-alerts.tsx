import React from "react";
import { Bell, BellOff, BellRing, Smartphone, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  pushSupport,
  getAlertStatus,
  enableAlerts,
  disableAlerts,
  sendTestAlert,
  type AlertStatus,
} from "@/lib/push-client";

// One-time "turn on push for this device" control. Replaces Telegram: alerts are
// sent by our own server and arrive on the installed dashboard PWA.
export function EnableAlerts() {
  const { toast } = useToast();
  const support = React.useMemo(() => pushSupport(), []);
  const [status, setStatus] = React.useState<AlertStatus | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(() => {
    getAlertStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  if (!support.supported) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-4 text-sm flex items-start gap-3">
        <Smartphone className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
        <div>
          <div className="font-medium">Enable device alerts</div>
          <p className="text-muted-foreground mt-1">{support.reason}</p>
        </div>
      </div>
    );
  }

  const subscribed = status?.subscribed && status?.permission === "granted";

  const onEnable = async () => {
    setBusy(true);
    try {
      await enableAlerts();
      toast({ title: "Alerts on", description: "This device will now receive your brief and urgent alerts." });
      refresh();
    } catch (err) {
      toast({ variant: "destructive", title: "Couldn't enable alerts", description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    setBusy(true);
    try {
      const r = await sendTestAlert();
      toast({ title: "Test sent", description: `Delivered to ${r.sent} device(s).` });
    } catch (err) {
      toast({ variant: "destructive", title: "Test failed", description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Turning alerts off is a two-tap action, and this is not politeness — it is the
  // fix for a real outage. On 2026-08-26 a single stray tap on "Turn off" (it sits
  // millimetres from "Send test" on a phone) removed the last subscribed device and
  // silenced EVERY agent nudge for five days. Nothing in the code unsubscribes on
  // its own, so the only way this channel dies is a mis-tap — so the mis-tap is what
  // we guard. The armed state self-disarms, so an accidental first tap decays to
  // nothing rather than waiting to catch a second one.
  const disarmTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [armedOff, setArmedOff] = React.useState(false);

  React.useEffect(() => () => { if (disarmTimer.current) clearTimeout(disarmTimer.current); }, []);

  const disarm = () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setArmedOff(false);
  };

  const onDisable = async () => {
    if (!armedOff) {
      setArmedOff(true);
      disarmTimer.current = setTimeout(() => setArmedOff(false), 5000);
      return;
    }
    disarm();
    setBusy(true);
    try {
      await disableAlerts();
      toast({
        variant: "destructive",
        title: "Alerts OFF for this device",
        description: "You will get no briefs, approvals or storm alerts here until you turn them back on.",
      });
      refresh();
    } catch (err) {
      toast({ variant: "destructive", title: "Couldn't turn off", description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4 flex items-center gap-3 flex-wrap">
      <div className={`flex-shrink-0 ${subscribed ? "text-emerald-500" : "text-muted-foreground"}`}>
        {subscribed ? <BellRing className="w-5 h-5" /> : <Bell className="w-5 h-5" />}
      </div>
      <div className="flex-1 min-w-[12rem]">
        <div className="font-medium text-sm">Device alerts {subscribed ? "are on" : "are off"}</div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {subscribed
            ? "Your morning brief and urgent items push to this device. No Telegram."
            : "Turn on push for this device to get your brief and urgent alerts here."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        {!subscribed ? (
          <button
            onClick={onEnable}
            disabled={busy}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors font-medium"
          >
            <Bell className="w-3.5 h-3.5" /> Enable alerts
          </button>
        ) : (
          <>
            <button
              onClick={onTest}
              disabled={busy}
              className="flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-md border hover:bg-accent disabled:opacity-60 transition-colors"
            >
              <BellRing className="w-4 h-4" /> Send test
            </button>
            {/* Held well clear of "Send test" (ml-6) and never the default action: the
                two sat side by side at tap-target size when the 8/26 mis-tap happened. */}
            <button
              onClick={onDisable}
              onBlur={disarm}
              disabled={busy}
              aria-label={armedOff ? "Confirm turning alerts off" : "Turn alerts off for this device"}
              className={
                armedOff
                  ? "ml-6 flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-md border border-destructive bg-destructive text-destructive-foreground font-semibold disabled:opacity-60 transition-colors"
                  : "ml-6 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-accent disabled:opacity-60 transition-colors"
              }
            >
              <BellOff className={armedOff ? "w-4 h-4" : "w-3.5 h-3.5"} />
              {armedOff ? "Tap again to silence alerts" : "Turn off"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
