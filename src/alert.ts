import { env } from './env';

export async function alertToTelegram(
  channel: string,
  event: string,
  metadata?: Record<string, string>
) {
  const alertUrl = env().ALERT_URL;
  if (alertUrl) {
    return await fetch(alertUrl, {
      method: 'POST',
      body: JSON.stringify({
        channel,
        event,
        metadata,
      }),
    });
  } else {
    console.log(`alert-not-reporting: 
    channel: ${channel} 
    event: ${event} 
    metadata: ${JSON.stringify(metadata)}`);
  }
  return null;
}
