# Baniya — Config file (bulk-import setup)

Instead of typing every setting on every device, you can hand out **one JSON
file** that configures a phone or the web portal in one tap. This is the fastest
way to onboard staff devices or set up the admin portal.

Start from **[`config.example.json`](./config.example.json)** — copy it, fill in
your values, and import it.

> **Save it as anything except `prod.json`.** A good name is `baniya-config.json`.
> (`prod.json` is reserved for the Firebase *service-account* key used by other
> tools — a real secret. This config file is a different, shareable thing.)

---

## What goes in it

```jsonc
{
  "version": 1,
  "shopCode": "your-shop-code",          // the same code on every device that shares data

  "firebase": {                          // your Firebase WEB config (public, safe to share)
    "apiKey": "AIzaSy…",                 //   Firebase Console → Project settings → Your apps (Web)
    "projectId": "your-project-id",
    "appId": "1:000…:web:…",
    "authDomain": "your-project-id.firebaseapp.com",     // optional (auto-derived)
    "messagingSenderId": "000000000000", // optional
    "storageBucket": "your-project-id.appspot.com"       // optional (auto-derived)
  },

  "business": {                          // what prints on bills (mobile app)
    "name": "Your Shop",
    "phone": "+91 …",
    "address": "…",
    "gst": "…"
  },

  "cloudinary": {                        // product images in the portal (optional)
    "cloudName": "your-cloud-name",
    "uploadPreset": "your-unsigned-preset"
  },

  "shop": {                              // admin contact shown to clients (portal)
    "display_name": "Your Shop",
    "admin_contact_email": "owner@yourshop.example",
    "admin_contact_phone": "+91 …"
  }
}
```

### Which app reads which block
Both apps **ignore** blocks they don't use and **merge** what they do — so one
file is safe to import into both. You can also ship a partial file (e.g. only
`firebase` + `shopCode`) and it won't wipe anything already set.

| Block | Mobile app | Web portal |
|---|---|---|
| `shopCode` | ✅ | ✅ |
| `firebase` | ✅ | ✅ |
| `business` (name/phone/address/gst) | ✅ (prints on bills) | — |
| `cloudinary` | — | ✅ (image uploads) |
| `shop` (display_name / admin contact) | — | ✅ |

### Where each value comes from
- **`shopCode`** — the stable code you chose for this shop. Every device with the
  same code syncs together.
- **`firebase.*`** — Firebase Console → ⚙️ **Project settings → General → Your
  apps → Web app** → the `firebaseConfig` snippet. This is the **web** config
  (public key), *not* the service-account key.
- **`business.*`** — your shop's name, phone, address, GST — printed on bills.
- **`cloudinary.*`** — Cloudinary → Console (cloud name) + an **unsigned** upload
  preset you create under Settings → Upload.
- **`shop.*`** — the contact details clients see (stored on the server via the portal).

> 🔒 **Safe to share with staff.** The Firebase web `apiKey` is public by design
> (access is controlled by your Firestore security rules). **Never** put a
> service-account private key, Supabase key, or any `.env` secret in this file.

---

## How to import it

### Mobile app (Android)
1. Put the filled `baniya-config.json` on the device (share it via WhatsApp/email/
   USB, or download it).
2. Open the app → **Settings**.
3. Tap **“Import settings JSON”** and pick the file.
4. You'll see a confirmation of what was applied (business / firebase / shop code).
   Sync starts automatically once Firebase config + shop code are set.

### Web portal
1. Open the portal → log in as admin → **Settings**.
2. Under **“Bulk import config”**, click the file picker and choose your
   `baniya-config.json`.
3. It applies the `firebase`, `cloudinary`, `shop`, and `shopCode` values and
   saves them (the Firebase config is stored in your browser).

That's it — no field-by-field typing. To reconfigure later, edit the JSON and
re-import; only the fields you include are changed.
