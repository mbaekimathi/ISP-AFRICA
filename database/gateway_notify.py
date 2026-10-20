"""Notification channels for gateway events.

The in-app channel is implemented now: it writes gateway_notifications rows
that the client and company feeds can surface. SMS and email are declared
adapters — they intentionally raise NotImplementedError, so a real OTP or
outbound delivery can be added later without changing call sites.
"""

import uuid

import gateway_store


class NotificationChannel:
    """Delivery target for a gateway notice."""

    name = "base"

    def send(self, cursor, notice):  # pragma: no cover - abstract
        raise NotImplementedError


class InAppNotificationChannel(NotificationChannel):
    """Persists the notice in gateway_notifications for the in-app feeds."""

    name = "in_app"

    def send(self, cursor, notice):
        cursor.execute(
            """
            INSERT INTO gateway_notifications
              (id, company_id, audience, client_id, kind, subject, detail)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                notice["id"],
                gateway_store.COMPANY_ID,
                notice["audience"],
                notice.get("client_id"),
                notice["kind"],
                notice["subject"],
                notice.get("detail") or "",
            ),
        )
        return notice["id"]


class SmsNotificationChannel(NotificationChannel):
    name = "sms"

    def send(self, cursor, notice):
        raise NotImplementedError("SMS delivery is not implemented yet.")


class EmailNotificationChannel(NotificationChannel):
    name = "email"

    def send(self, cursor, notice):
        raise NotImplementedError("Email delivery is not implemented yet.")


def notice(audience, kind, subject, detail="", client_id=None):
    return {
        "id": str(uuid.uuid4()),
        "audience": audience,
        "client_id": client_id,
        "kind": kind,
        "subject": str(subject or "")[:120],
        "detail": str(detail or "")[:255],
    }


def send(cursor, item, channels=None):
    """Deliver a notice through the given channels (in-app by default)."""
    delivered = []
    for channel in channels or [InAppNotificationChannel()]:
        channel.send(cursor, item)
        delivered.append(channel.name)
    return delivered


def feed_items(cursor, audience, client_id=None, limit=50):
    """Rows the in-app feeds merge in (wired up in a later phase)."""
    if audience == "client":
        cursor.execute(
            """
            SELECT id, kind, subject, detail, created_at
            FROM gateway_notifications
            WHERE audience = 'client' AND client_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (client_id, int(limit)),
        )
    else:
        cursor.execute(
            """
            SELECT id, kind, subject, detail, created_at
            FROM gateway_notifications
            WHERE audience = 'company'
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (int(limit),),
        )
    return list(cursor.fetchall())
