import { Clause, Document, TextLink } from '@/system';

// Shown only on a Sift run as a service for other people (`SIFT_CLOUD`): "we" is whoever runs it, with
// their own Google client. Until it has an address of its own, people reach it through the repository. Google's verification reads these pages: the Limited Use
// statement must stay word for word, and what they say sift keeps must stay true of the code. The security
// page is held to docs/security.md and AGENTS.md's safety rules the same way.
const UPDATED = 'November 19, 2026';
const SOURCE = 'https://github.com/dcramer/sift';
const USER_DATA_POLICY = 'https://developers.google.com/terms/api-services-user-data-policy';
const PERMISSIONS = 'https://myaccount.google.com/permissions';
const ISSUES = `${SOURCE}/issues`;
// GitHub's private vulnerability reporting: seen only by the repository's maintainers.
const REPORT = `${SOURCE}/security/advisories/new`;

export function PrivacyView() {
  return (
    <main>
      <Document title="Privacy policy" updated={UPDATED}>
        <p>
          Sift helps manage a Gmail inbox: it classifies mail, and, as you tell it to, archives it, marks it as spam or unsubscribes from it. This Sift is run
          by the person or organisation that set it up (“we”). Sift is <TextLink href={SOURCE}>open source</TextLink>, and anyone can run a copy: this policy is
          ours, for this one.
        </p>

        <Clause title="What Sift reads">
          <ul>
            <li>Your Google account’s email address, when you sign in.</li>
            <li>
              Your Gmail, through two permissions. <strong>gmail.modify</strong> lets it read messages and their labels, label them, archive them and mark them
              as spam. <strong>gmail.settings.basic</strong> lets it add and remove Gmail filters for the rules you ask it to copy into Gmail. Only if you turn
              on Inbox and allow it, <strong>gmail.send</strong> lets it send mail you write in the dashboard and press Send on. It never sends anything by
              itself, and it never deletes or trashes mail.
            </li>
            <li>
              For each message in your inbox: its headers (sender, recipients, subject, date, the sender’s authentication results, mailing list and unsubscribe
              headers) and its Gmail labels.
            </li>
            <li>Its body, once, only when a model is about to judge it, it waits for your answer, or you answer for it.</li>
            <li>
              Whether you have written to a sender, and for a reply, whether you wrote earlier in the thread. No other message’s content is read for this.
            </li>
          </ul>
        </Clause>

        <Clause title="What Sift keeps">
          <ul>
            <li>A record of every message it reads: the facts from its headers and its subject, not its body.</li>
            <li>Every decision it made and every change it made to your mailbox, so you can see why and undo it.</li>
            <li>Your labels, rules and answers.</li>
            <li>The text of each message whose body it read, for 30 days from reading it, so it never has to read it again.</li>
            <li>
              The text of each message you answered for, kept as an example that teaches Sift your preferences, until you delete it in the dashboard or the
              period we set for examples ends.
            </li>
            <li>Google’s access token for your account, stored apart from your mail, readable only by Sift, and encrypted when we have set a key.</li>
          </ul>
          <p>
            Each person’s mail is kept in a database of its own, and the dashboard shows you only your own mailboxes. We may set Sift to forget messages nothing
            has happened to after a number of days; otherwise everything is kept until it is deleted.
          </p>
        </Clause>

        <Clause title="How it is used">
          <p>
            Only to classify your mail the way you set it up, and to show you what Sift did and what it would do. It is not used for advertising, not sold, and
            not used to train AI models beyond teaching Sift, through your examples, what your own mail is.
          </p>
          <p>
            No person reads your mail through Sift but you, unless you ask us to (to look into a problem, say), it is needed to keep Sift secure, or the law
            requires it.
          </p>
        </Clause>

        <Clause title="Who else receives it">
          <ul>
            <li>
              <strong>An AI model provider.</strong> When none of your rules decides a message, Sift asks a language model which of your labels it is. The model
              is sent the message’s sender, subject, the facts from its headers, the start of its text, your guidance and a few of your past examples, and
              answers with a label. The provider is the one you connect (ChatGPT, OpenAI, Anthropic, OpenRouter or Vercel AI Gateway), and its terms for your
              account decide what it keeps and whether it may train on it. The model can only answer: it cannot act on your mailbox. The{' '}
              <TextLink href="/security">security page</TextLink> lists what it is sent.
            </li>
            <li>
              <strong>Senders you unsubscribe from.</strong> Only where your label or rule says to, Sift sends the sender’s own one-click unsubscribe request,
              which tells them that your address unsubscribed.
            </li>
            <li>
              <strong>Google</strong>, which holds your mail and carries out the changes Sift makes to it.
            </li>
          </ul>
          <p>No one else, unless the law requires it.</p>
        </Clause>

        <Clause title="Google user data">
          <p>
            Sift’s use and transfer of information received from Google APIs to any other app will adhere to the{' '}
            <TextLink href={USER_DATA_POLICY}>Google API Services User Data Policy</TextLink>, including the Limited Use requirements.
          </p>
        </Clause>

        <Clause title="Stopping and deleting">
          <ul>
            <li>Delete examples in the dashboard, one at a time or all of a mailbox’s.</li>
            <li>
              Remove Sift’s access at any time in your <TextLink href={PERMISSIONS}>Google account’s permissions</TextLink>. Sift then cannot read or change
              your mail.
            </li>
            <li>
              Remove a mailbox, or delete your account, under Settings. Sift revokes its access at Google and deletes everything it holds about that mail. The
              Gmail filters it wrote stay in Gmail until you delete them there.
            </li>
          </ul>
        </Clause>

        <Clause title="Children">
          <p>Sift is not for anyone under 13.</p>
        </Clause>

        <Clause title="Changes and contact">
          <p>
            When this policy changes, the date above changes with it. See also the <TextLink href="/terms">terms of service</TextLink>.
          </p>
          <p>
            Ask a question or make a request in <TextLink href={ISSUES}>an issue on GitHub</TextLink>. Issues are public: for anything about your own data, ask
            us to get in touch and leave the details out.
          </p>
        </Clause>
      </Document>
    </main>
  );
}

export function TermsView() {
  return (
    <main>
      <Document title="Terms of service" updated={UPDATED}>
        <p>
          These terms are between you and the person or organisation running this Sift (“we”). By signing in, you agree to them and to the{' '}
          <TextLink href="/privacy">privacy policy</TextLink>.
        </p>

        <Clause title="What Sift does">
          <p>
            Sift decides what each message in your Gmail inbox is, from rules you write, from what it has learned from your answers and, when those do not
            decide, from a language model. What happens to a label’s mail is yours to choose. Until you turn Sift on, it only suggests: nothing in Gmail changes
            but the messages you answer for in the dashboard.
          </p>
          <p>
            When it acts, it only labels, archives, marks as read or as spam, and unsubscribes, and only mail still in your inbox. It never forwards or deletes,
            and never sends or replies by itself: it sends only mail you write and press Send on, with Inbox on. Each change is recorded, and you can undo it
            from the dashboard; mail sent cannot be taken back.
          </p>
        </Clause>

        <Clause title="Your part">
          <ul>
            <li>Sign in only with a Gmail account that is yours, or that you are allowed to manage.</li>
            <li>Check what Sift suggests before turning it on. A model can be wrong, and a rule does what it says even when that is not what you meant.</li>
            <li>Don’t use Sift to break the law, to reach anyone else’s mail, or to interfere with this Sift or what it runs on.</li>
          </ul>
        </Clause>

        <Clause title="Other services">
          <p>
            Sift works through Google’s services and an AI model provider, and their own terms apply to them. We are not responsible for what they do, or for
            the websites of senders you unsubscribe from.
          </p>
        </Clause>

        <Clause title="No warranty">
          <p>
            Sift is provided as it is, without warranties of any kind. We do not promise it will classify every message correctly, be available all the time, or
            keep every record.
          </p>
        </Clause>

        <Clause title="Liability">
          <p>
            As far as the law allows, we are not liable for indirect or consequential loss arising from your use of Sift, including mail that was missed,
            mislabelled, archived or marked as spam.
          </p>
        </Clause>

        <Clause title="Ending">
          <p>
            You can stop at any time by deleting your account under Settings, which deletes your data, or by removing Sift’s access in your{' '}
            <TextLink href={PERMISSIONS}>Google account</TextLink>. We may end your access to this Sift at any time.
          </p>
        </Clause>

        <Clause title="Changes">
          <p>When these terms change, the date above changes with them. Using Sift after that means you accept the new terms.</p>
        </Clause>
      </Document>
    </main>
  );
}

export function SecurityView() {
  return (
    <main>
      <Document title="Security" updated={UPDATED}>
        <p>
          Sift can read your Gmail and keeps some of your mail. This is how that access is limited, how what it holds is protected, and where that protection
          ends. Sift is <TextLink href={SOURCE}>open source</TextLink>: everything here can be checked in its code.
        </p>

        <Clause title="What Sift can do to your mail">
          <ul>
            <li>It asks Google to read and label mail and to manage filters. It never deletes or trashes mail.</li>
            <li>
              It sends mail only if you turn on Inbox and Google asks you to allow it, and then only mail you write in the dashboard and press Send on. It never
              sends anything by itself, and the model that reads your mail cannot send.
            </li>
            <li>Until you turn it on, it changes nothing in Gmail but the messages you answer for yourself.</li>
            <li>
              It changes only messages still in your inbox, and reads their labels again just before. Each change is recorded before it is made and checked
              against Gmail after, and you can undo it from the dashboard.
            </li>
            <li>
              It unsubscribes only where your label or rule says to, and only through the sender’s own one-click unsubscribe address, over HTTPS to the public
              internet. It never opens a link from a message.
            </li>
            <li>
              Anything that acts on a sender’s address, such as blocking or unsubscribing, needs the message to have passed its domain’s authentication (DMARC),
              so a forged sender cannot turn it on someone else.
            </li>
          </ul>
        </Clause>

        <Clause title="The AI model">
          <p>
            You choose it. Each person connects their own, by signing in with ChatGPT or with an API key from OpenAI, Anthropic, OpenRouter or Vercel AI
            Gateway, and picks which of that provider’s models to use. Sift calls it with your sign-in, so the provider’s terms for your account decide what it
            keeps and whether it may train on it. API accounts at OpenAI and Anthropic are not trained on by default; a ChatGPT sign-in follows your ChatGPT
            data controls.
          </p>
          <p>A message goes to the model only when none of your rules decides it. The model is sent:</p>
          <ul>
            <li>your labels and what each is for;</li>
            <li>
              the message’s sender, recipients and subject, what its headers say (such as whether it passed authentication or came from a mailing list), and its
              text, up to 4,000 characters;
            </li>
            <li>
              what Sift knows of the sender: how much mail they have sent, whether you have written to them, how you labelled their earlier mail, and any rule
              you have for them;
            </li>
            <li>up to six messages you answered for before, each as its sender, its subject and its first 300 characters.</li>
          </ul>
          <p>
            When you ask the model to suggest labels, it sees only what you wrote, none of your mail. When you describe a rule, it also sees your labels and can
            look up senders in your own record.
          </p>
          <p>
            All it can do is answer: it has no way to change your mailbox, send anything, open a link or run anything, so a message written to give it
            instructions has nothing to work with. What happens to a label’s mail is set by you, never by the model. When it is unsure, or the call fails, the
            message is left alone for you.
          </p>
        </Clause>

        <Clause title="Encryption">
          <p>
            Sift encrypts what it stores on its server with AES-256-GCM, under a key for the whole install. The key is kept in the server’s environment, never
            in the database or the code, so a copy of the database or a backup reveals no mail on its own.
          </p>
          <ul>
            <li>
              Encrypted: your Google and model sign-ins; the text of the mail Sift keeps; every message’s headers, which say who sent it, to whom and about
              what; and anything else that names a sender, such as a rule’s conditions or the reason for a decision.
            </li>
            <li>Each value is sealed to the person and the thing it belongs to. Moved into another account, or onto another message, it does not open.</li>
            <li>
              Senders are looked up by a code made with a key derived for you alone. The database can tell that two messages share a sender without showing who
              it is, and does not show that two people hear from the same sender.
            </li>
            <li>
              Not encrypted: your labels, the parts of rules written in your own words, and what was decided and done, when. What is kept, and for how long, is
              in the <TextLink href="/privacy">privacy policy</TextLink>.
            </li>
            <li>
              Google and the model provider are reached only over HTTPS. Hosted, the database connection is encrypted too, and the host encrypts its disks.
            </li>
          </ul>
          <p>
            It is not end-to-end encryption: the server holds the key, so it can read what it stores. It has to, because it judges new mail by your past answers
            while you are away. Encryption protects a leaked copy of the database, not a server someone else controls.
          </p>
        </Clause>

        <Clause title="Keeping people apart">
          <p>
            Every row of your data carries your account. Each query Sift makes is limited to whoever is signed in, and the database enforces the same limit
            again by itself, so one mistake in the code does not show anyone your mail. Every request the dashboard answers is tested as two people, one asking
            for the other’s mail.
          </p>
        </Clause>

        <Clause title="The dashboard">
          <ul>
            <li>You sign in with Google, and see only your own mailboxes. A sign-in lasts 30 days, in a cookie the page’s scripts cannot read.</li>
            <li>A change is accepted only from the dashboard’s own page, so another site cannot make one on your behalf.</li>
            <li>The page runs only its own code, loads nothing from any other site, and sends nothing to one but what is said of Sentry below.</li>
            <li>
              An email opened in the dashboard is shown walled off from the rest of the page: nothing in it runs and nothing loads, not even its images, so
              opening it does not tell the sender you read it.
            </li>
          </ul>
        </Clause>

        <Clause title="Who sees what">
          <ul>
            <li>Nobody running Sift reads your mail, and there is no tool for doing so.</li>
            <li>
              The server’s logs may name a mailbox, never a sender. Error reports, which go to Sentry, name a message or sender only by a meaningless id, carry
              nothing from your mail, and have email addresses removed before they leave.
            </li>
            <li>
              Your browser sends Sentry how long each page took and what failed on it, in the same way: no address, and no part of a link that names a message
              or sender.
            </li>
            <li>An error from the model provider is recorded as its kind, never its text, which can quote your mail.</li>
          </ul>
        </Clause>

        <Clause title="How it is built">
          <p>
            Only one part of the code can reach Google, only one can change your mailbox, and only one can call a model; checks on every change refuse code that
            crosses those lines. Every Gmail filter is checked before it is written, whoever proposed it. Every change runs the type checks, the tests and the
            browser tests before it is committed, and again on GitHub.
          </p>
        </Clause>

        <Clause title="What it does not protect against">
          <ul>
            <li>Someone with both the database and the key can read everything stored, your Google access included.</li>
            <li>Whoever controls the server Sift runs on, since it holds the key and your Google access.</li>
            <li>Mail while it is being classified: it is read from Gmail, and the model provider is sent what is listed above.</li>
          </ul>
        </Clause>

        <Clause title="If something is wrong">
          <p>
            To cut Sift off at once, remove its access in your <TextLink href={PERMISSIONS}>Google account’s permissions</TextLink>; that ends every token it
            was given. Report a security problem <TextLink href={REPORT}>privately on GitHub</TextLink>, not in a public issue.
          </p>
        </Clause>
      </Document>
    </main>
  );
}
