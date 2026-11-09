# Small Group Scheduler

A shared calendar and date-polling app for small groups, hosted on Netlify.

- **Accounts:** people sign up with their name, email and a password.
- **Groups:** after signing up, each person either **joins a group with its code** or **starts a new group** and picks its code. Group names must be unique: capitalization, spacing and punctuation are ignored, so "Men's Breakfast" and "mens breakfast" count as the same name. One person can be in several groups and switch between them with the switcher next to their account icon, which also lets them join or create more. Each group has its own calendar, polls, members and emails.
- **Organizers:** whoever creates a group is its organizer. Organizers can rename the group, change its code (the old code stops working), make others organizers, and remove members. A group must always have at least one organizer. Any member can see the code, so they can invite people.
- **Calendar:** any member can add an event with a title, description, date, time, location and cost. You can only edit or delete events you added; organizers can edit or delete any of them. Each event has an "Add to My Calendar" (.ics) button.
- **Polls:** propose an event with two or more date and time options. Members mark each option Yes, Maybe or No. The poll shows who answered what, when they responded, and who hasn't replied yet. The poll's creator (or the organizer) picks the final date, and it goes on the calendar.
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
| `APP_NAME` | recommended | `Foster Small Group` | The name shown in the app and in emails |
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

## Notes
- **Free Netlify plan:** fine for a small group. Every page load makes a few quick function calls.
- **Upgrading from the single-group version:** on first launch, existing members, events and polls move automatically into one group named after `APP_NAME`, with a generated code. The old organizer becomes its organizer, and can see and change the code under Group Info.
- **Data:** stored in the site's Netlify Blobs store, named `smallgroup`. You can browse it under **Netlify → your site → Blobs**, or with `netlify blobs:list smallgroup`. It persists across deploys.
- **Security:** passwords are hashed with scrypt, sessions use HttpOnly cookies that last 60 days, and everything is served over HTTPS on Netlify.
- **Time zones:** dates and times are stored as entered ("7:00 PM on Nov 20"). They aren't converted between time zones, which is what a local group usually wants.
- **Local development:** `npm install`, then `netlify dev`. It opens at http://localhost:8888.
