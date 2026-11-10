# Groups — Small Group Scheduler

A shared calendar and date-polling app for small groups, hosted on Netlify.

- **Accounts:** people sign up with their name, email and a password.
- **Groups:** after signing up, each person either **joins a group with its code** or **starts a new group** and picks its code. Group names must be unique: capitalization, spacing and punctuation are ignored, so "Men's Breakfast" and "mens breakfast" count as the same name. One person can be in several groups and switch between them with the switcher next to their account icon, which also lets them join or create more. Each group has its own calendar, polls, members and emails.
- **Organizers:** whoever creates a group is its organizer. Organizers can rename the group, change its code (the old code stops working), make others organizers, and remove members. A group must always have at least one organizer. Any member can see the code, so they can invite people.
- **Calendar:** any member can add an event with a title, description, date, time, location and cost. You can only edit or delete events you added; organizers can edit or delete any of them. Each event has an "Add to My Calendar" (.ics) button.
- **Polls:** propose an event with two or more date and time options. Members mark each option Yes, Maybe or No. The poll shows who answered what, when they responded, and who hasn't replied yet. The poll's creator (or the organizer) picks the final date, and it goes on the calendar. The poll's creator or a group organizer can edit an open poll: change the details, add, change or remove dates. Adding dates keeps everyone's responses; changing an option's date or time clears the responses for that option only.
- **Pitch-in:** turn on Pitch-in when creating a poll or an event. Members sign up for one or more items, each with a category ( main, side, salad, bread, dessert, drinks, supplies, other) and everyone sees a "who's bringing what" summary. Sign-ups on a poll carry over to the event when the date is picked.
- **Email:** every member of a group gets an email, with the group name in the subject, when an event is added, a poll is created, or a poll date is scheduled. Members can turn emails off from their profile. Password reset links also go out by email.

No build step and no framework. The front end is plain HTML, CSS and JS in `public/`. The back end is one Netlify Function, `netlify/functions/api.mjs`, that stores data in **Netlify Blobs**, which is built into Netlify and needs no setup.

---

## Deploy to Netlify

### 1. Put the code on GitHub
Create a new GitHub repository (private is fine) and upload the contents of this folder to it.

### 2. Create the site on Netlify
1. In Netlify, choose **Add new site → Import an existing project → GitHub** and pick the repository.
2. Netlify reads `netlify.toml`, so you can leave the build settings alone (publish directory `public`, functions directory `netlify/functions`).
3. Click **Deploy**.

> Drag-and-drop deploys (Netlify Drop) **won't work**. The function needs Netlify to install `@netlify/blobs` during the build, which only happens with a Git-connected site or the CLI.
>
> If you'd rather use the CLI: `npm i -g netlify-cli`, `netlify login`, `netlify init`, then `netlify deploy --prod`.

### 3. Set environment variables
Go to **Site configuration → Environment variables** and add:

| Variable | Required | Example | What it does |
|---|---|---|---|
| `APP_NAME` | optional | `Groups` | The app's name, shown in the header and sign-in page (default: Groups) |
| `RESEND_API_KEY` | for email | `re_xxxxxxxx` | Your Resend API key (see below) |
| `EMAIL_FROM` | for email | `Small Group <group@yourdomain.com>` | The sender. It must use a domain you've verified in Resend |
| `APP_URL` | optional | `https://oursmallgroup.netlify.app` | The link used in emails. Netlify fills this in automatically; set it only if you use a custom domain |

Redeploy after changing variables: **Deploys → Trigger deploy**.

### 4. Set up email (Resend)
1. Create an account at resend.com.
2. **Domains → Add Domain** and add the DNS records it gives you. A subdomain such as `mail.yourdomain.com` works.
3. **API Keys → Create** and paste the key into `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to an address on that verified domain.

Until a domain is verified, Resend only delivers to your own Resend account email. Until a key is set, the app still works but skips emails.

To check email status, sign in as the organizer and tap your avatar. **Email delivery** shows *Connected*, *Not set up*, or *Last send failed*. Netlify's function logs show the error details.

### 5. Invite your group
Sign up, choose **Start a Group**, and pick a code. Then open **Members** (or **Group Info & Invite** in the group switcher) and tap **Copy Invite** to get a message with the link and code to send.

---

## Meal trains

Organizers turn on **Meal Trains** in Group Info › Features. Any member can then start a train for a family:
pick a date range, which weekdays need a meal, a drop-off window, food notes and the (private) address.

- Each train has a public link (`/m/<token>`) anyone can use to sign up, with no account needed. The page never shows the
  address or phone; volunteers get them on their confirmation screen and by email.
- Volunteers get a private link (`/m/manage/<token>`) to change or cancel, plus a reminder email the day before
  (sent by the hourly `meal-reminders` scheduled function from 9 AM in the train's time zone).
- Coordinators get an email for each sign-up, change or cancellation, can see volunteers' contact info, remove sign-ups,
  close sign-ups, or make a new link (which turns the old one off).

## Security, encryption and backups

**Settings** (Netlify › Site configuration › Environment variables, mark secret ones as *Secret*):

| Variable | Purpose |
|---|---|
| `DATA_ENCRYPTION_KEY` *(secret)* | Encrypts prayer requests, discussions and backup files (AES-256-GCM). Keep a copy somewhere safe (a password manager) — **without it, encrypted data and backups can't be read**. Don't change it once set. |
| `ADMIN_EMAILS` | Comma-separated sign-in emails that can open Profile › Site Backups. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` *(secret)* | Optional: off-site copies to Google Drive. |

- Existing prayer requests and discussions are encrypted automatically the first time the app runs with a key.
- **Nightly backups** (`backup-nightly`, 3 AM Eastern) snapshot all data into a separate `smallgroup-backups` store; 30 nightly snapshots are kept. Site admins can back up now, download (encrypted, compressed file) and restore. A restore first saves a safety snapshot.
- **Google Drive**: create a Google Cloud OAuth client (Web application) with redirect URI `https://<your-domain>/api/admin/gdrive/callback`, enable the Google Drive API, set the OAuth consent screen to **In production** (in *Testing*, Google expires the connection after 7 days), then use *Connect Google Drive* in Site Backups. The app only gets the `drive.file` scope (files it creates).
- Deploy previews and branch deploys use their own separate data store, so test code never touches production data.

## Notes
- **Free Netlify plan:** fine for a small group. Every page load makes a few quick function calls.
- **Upgrading from the single-group version:** on first launch, existing members, events and polls move automatically into one group named after `APP_NAME`, with a generated code. The old organizer becomes its organizer, and can see and change the code under Group Info.
- **Data:** stored in the site's Netlify Blobs store, named `smallgroup`. You can browse it under **Netlify → your site → Blobs**, or with `netlify blobs:list smallgroup`. It persists across deploys.
- **Security:** passwords are hashed with scrypt, sessions use HttpOnly cookies that last 60 days, and everything is served over HTTPS on Netlify.
- **Time zones:** dates and times are stored as entered ("7:00 PM on Nov 20"). They aren't converted between time zones, which is what a local group usually wants.
- **Local development:** `npm install`, then `netlify dev`. It opens at http://localhost:8888.
