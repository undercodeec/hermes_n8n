-- Fail rather than silently discard existing duplicate first-purchase events.
CREATE UNIQUE INDEX "advertising_conversion_first_purchase_contact_key"
ON "advertising_conversions" ("contactId")
WHERE "eventType" = 'CONTRACT_WON' AND "contactId" IS NOT NULL;
