// أتمتة Challenge Academy على خطة Spark (بدون Cloud Functions)
// 1) تحويل طلب المتجر للبائع التالي عند التأخر أو عدم التوفر
// 2) حذف طلبات المتجر غير المسددة بعد 24 ساعة من الموافقة
// 3) إلغاء الحجوزات غير المسددة بعد المهلة المضبوطة في إعدادات الأكاديمية + تذكير عند نصف المهلة
// 4) نظام التقييد (المخالفات)  5) الدورة الشهرية: تثبيت / تجديد / تذكير سداد / إلغاء + إشعار تغيّر المرحلة
// 6) نظام البدلاء: بناء المرشحين، فتح الموعد بعد المهلة، تنفيذ القبول/الرفض، إبلاغ قائمة الانتظار

const admin = require("firebase-admin");
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ السر FIREBASE_KEY غير موجود أو ليس JSON صالحًا. انسخ محتوى ملف الـ Service Account كاملًا.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ===== الإعدادات (مطابقة لما في التطبيق) =====
const TZ = "Africa/Cairo";
const VENDOR_TIMEOUT_MIN = 180;          // مهلة رد البائع (دقائق عمل فعلية)
const DAY_START = 10, DAY_END = 22;      // ساعات العمل المحتسبة (10ص - 10م بتوقيت القاهرة)
const SHOP_PAY_WINDOW_MS = 24 * 3600 * 1000; // مهلة سداد المتجر
// ==============================================

const pad = (n) => String(n).padStart(2, "0");
// تاريخ "حائط" بتوقيت القاهرة (للحسابات فقط)
const cairo = (d = new Date()) => new Date(d.toLocaleString("en-US", { timeZone: TZ }));

function activeMinutes(fromReal, toReal) {
  const from = cairo(fromReal), to = cairo(toReal);
  if (!(to > from)) return 0;
  let total = 0;
  let day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (day <= to) {
    const ws = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAY_START);
    const we = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAY_END);
    const st = from > ws ? from : ws;
    const en = to < we ? to : we;
    if (en > st) total += Math.floor((en - st) / 60000);
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return total;
}

// ---------- الإشعارات (إشعار داخل التطبيق + Push عبر OneSignal) ----------
async function pushTo(target, n, nid) {
  const appId = process.env.ONESIGNAL_APP_ID, key = process.env.ONESIGNAL_REST_KEY;
  if (!appId || !key) return;
  const res = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Key ${key}` },
    body: JSON.stringify({
      app_id: appId,
      target_channel: "push",
      ...target,
      headings: { en: n.titleEn || n.title, ar: n.title },
      contents: { en: n.bodyEn || n.body || " ", ar: n.body || " " },
      data: { nid: nid || "", type: n.type || "general", rid: n.relatedId || "", action: n.action || "" },
      android_sound: "crsa_alert",
      ios_sound: "crsa_alert.wav",
      priority: 10,
    }),
  });
  if (!res.ok) console.log("OneSignal", res.status, (await res.text()).slice(0, 200));
}

async function notify(uid, n) {
  if (!uid) return;
  try {
    const u = await db.collection("users").doc(uid).get();
    if (u.exists && u.data().notificationsMuted === true) return;
    const ref = await db.collection("notifications").add({
      userId: uid,
      title: n.title,
      body: n.body,
      ...(n.titleEn ? { titleEn: n.titleEn } : {}),
      ...(n.bodyEn ? { bodyEn: n.bodyEn } : {}),
      type: n.type || "general",
      relatedId: n.relatedId || null,
      ...(n.action ? { action: n.action } : {}),
      viaRelay: true, // يمنع الإرسال المزدوج لو نُشرت Functions لاحقًا
      isRead: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    await pushTo({ include_aliases: { external_id: [uid] } }, n, ref.id);
  } catch (e) {
    console.log("notify failed", uid, e.message);
  }
}

async function notifyAdmins(n) {
  const snap = await db.collection("users").where("role", "in", ["admin", "technicalManager"]).get();
  for (const d of snap.docs) await notify(d.id, n);
}

// ---------- 1) طابور البائعين ----------
async function advanceVendor(ref, reason, expectedAtMs) {
  const r = await db.runTransaction(async (tx) => {
    const o = (await tx.get(ref)).data();
    if (!o || o.fwdState !== "active") return null;
    const st = o.vendorStatus || "new";
    if (reason === "timeout") {
      if (st !== "new") return null;
      if ((o.fwdAssignedAt?.toMillis() || 0) !== expectedAtMs) return null; // تغيّر الإسناد
    }
    if (reason === "unavailable" && st !== "unavailable") return null;

    const queue = (o.fwdQueue || []).map(String);
    const idx = Number(o.fwdIndex || 0);
    const prev = queue[idx] || "";
    const log = [...(o.fwdLog || []), { vendorId: prev, reason, at: Timestamp.now() }];
    const next = idx + 1;

    if (next >= queue.length) {
      tx.update(ref, { fwdState: "needsAdmin", fwdLog: log, forwardedVendorIds: [], vendorStatus: FieldValue.delete() });
      return { o, prev, next: null };
    }
    tx.update(ref, {
      fwdIndex: next, fwdState: "active", fwdAssignedAt: FieldValue.serverTimestamp(),
      fwdLog: log, forwardedVendorIds: [queue[next]], vendorStatus: "new",
    });
    return { o, prev, next: queue[next] };
  });
  if (!r) return false;

  const buyer = r.o.buyerName || "";
  if (r.prev && reason === "timeout") {
    await notify(r.prev, {
      title: "حُوّل الطلب لبائع آخر", titleEn: "Order moved to another vendor",
      body: `تأخر الرد على طلب ${buyer} فتم تحويله وإلغاؤه من عندك.`,
      bodyEn: `No response in time for ${buyer}'s order; it was moved and removed from your list.`,
      type: "payment", relatedId: ref.id,
    });
  }
  if (r.next) {
    await notify(r.next, {
      title: "طلب جديد للتجهيز", titleEn: "New order to prepare",
      body: `${buyer} — يرجى الرد خلال 3 ساعات (من 10ص حتى 10م).`,
      bodyEn: `${buyer} — please respond within 3 hours (10am–10pm).`,
      type: "payment", relatedId: ref.id,
    });
  } else {
    await notifyAdmins({
      title: "الطلب بلا بائع متاح", titleEn: "Order has no available vendor",
      body: `لم يرد أي من البائعين المحددين أو لم يتوفر المنتج لديهم (${buyer}). حوّله لبائع آخر أو اعتذر.`,
      bodyEn: `No vendor responded or had the product (${buyer}). Forward it elsewhere or apologize.`,
      type: "payment", relatedId: ref.id,
    });
  }
  return true;
}

async function sweepVendorQueue() {
  const snap = await db.collection("shop_orders").where("fwdState", "==", "active").get();
  let n = 0;
  for (const doc of snap.docs) {
    const o = doc.data();
    const st = o.vendorStatus || "new";
    if (st === "unavailable") { if (await advanceVendor(doc.ref, "unavailable")) n++; continue; }
    if (st !== "new" || !o.fwdAssignedAt) continue;
    if (activeMinutes(o.fwdAssignedAt.toDate(), new Date()) >= VENDOR_TIMEOUT_MIN) {
      if (await advanceVendor(doc.ref, "timeout", o.fwdAssignedAt.toMillis())) n++;
    }
  }
  console.log("vendor queue advanced:", n);
}

// ---------- 2) طلبات المتجر غير المسددة ----------
async function deleteUnpaidShopOrders() {
  const snap = await db.collection("shop_orders").where("status", "==", "approvedAwaitingPayment").get();
  let n = 0;
  for (const doc of snap.docs) {
    const o = doc.data();
    const ts = o.approvedAt || o.createdAt;
    if (!ts || Date.now() - ts.toMillis() < SHOP_PAY_WINDOW_MS) continue;
    const ok = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(doc.ref)).data();
      if (!cur || cur.status !== "approvedAwaitingPayment") return false;
      tx.delete(doc.ref);
      return true;
    });
    if (!ok) continue;
    n++;
    await notify(String(o.parentId || ""), {
      title: "أُلغي طلبك من المتجر",
      body: "تم حذف طلبك تلقائياً لعدم السداد خلال 24 ساعة من الموافقة. يمكنك تقديم طلب جديد في أي وقت.",
      type: "payment", relatedId: doc.id,
    });
  }
  console.log("unpaid shop orders deleted:", n);
}

// ---------- 3) الحجوزات غير المسددة ----------
function selectionsOf(b) {
  if (Array.isArray(b.selections) && b.selections.length) return b.selections;
  if (!b.date) return [];
  return [{ slotId: b.slotId }];
}

async function releaseSlot(slotId, bookingId) {
  if (!slotId) return;
  const ref = db.collection("available_slots").doc(slotId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const d = s.data();
    let players = Array.isArray(d.bookedPlayers) ? [...d.bookedPlayers] : [];
    let freed = 1;
    for (const p of players) {
      if (p.bookingId === bookingId && typeof p.seats === "number" && p.seats > 0) freed = p.seats;
    }
    players = players.filter((p) => p.bookingId !== bookingId);
    tx.update(ref, { bookedCount: Math.max((d.bookedCount || 0) - freed, 0), bookedPlayers: players, isOpen: true });
  });
}

async function releaseAllSlots(b, bookingId) {
  for (const s of selectionsOf(b)) await releaseSlot(s.slotId, bookingId);
  if (b.category === "monthly") {
    const n = cairo();
    const today = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
    const snap = await db.collection("available_slots").where("date", ">=", today).get();
    for (const d of snap.docs) {
      const players = d.data().bookedPlayers || [];
      if (players.some((p) => p.bookingId === bookingId)) await releaseSlot(d.id, bookingId);
    }
  }
}

async function expireUnpaidBookings() {
  const cfg = (await db.collection("system_settings").doc("academy_config").get()).data() || {};
  const clamp = (v, def) => (typeof v === "number" ? Math.min(Math.max(Math.round(v), 5), 10080) : def);
  const training = clamp(cfg.payMinutesTraining, 60);
  const court = clamp(cfg.payMinutesCourt, 60);
  const monthlyMid = clamp(cfg.payMinutesMonthlyMid, 240);
  const c = cairo();
  const curMonth = `${c.getFullYear()}-${pad(c.getMonth() + 1)}`;

  const windowMin = (b) => {
    if (b.category === "monthly") return b.cycleMonth === curMonth ? monthlyMid : null;
    return String(b.type || "") === "courtBooking" ? court : training;
  };

  const snap = await db.collection("bookings").where("status", "==", "approvedAwaitingPayment").get();
  let cancelled = 0, reminded = 0;
  for (const doc of snap.docs) {
    const b = doc.data();
    if (!b.approvedAt) continue;
    const win = windowMin(b);
    if (win == null) continue;
    const elapsed = (Date.now() - b.approvedAt.toMillis()) / 60000;
    const parent = String(b.parentId || "");

    if (elapsed >= win) {
      const ok = await db.runTransaction(async (tx) => {
        const cur = (await tx.get(doc.ref)).data();
        if (!cur || cur.status !== "approvedAwaitingPayment") return false;
        tx.update(doc.ref, {
          status: "cancelled", cancelledAt: FieldValue.serverTimestamp(),
          cancellationReason: "لم يتم السداد خلال المهلة المحددة بعد الموافقة",
          cancellationKind: "unpaid_timeout", penaltyApplied: false,
        });
        return true;
      });
      if (!ok) continue;
      await releaseAllSlots(b, doc.id);
      cancelled++;
      await notify(parent, {
        title: "❌ تم إلغاء حجزك", body: `تم إلغاء حجز ${b.sport || ""} لعدم السداد خلال المهلة المحددة.`,
        type: "cancellation", relatedId: doc.id,
      });
    } else if (elapsed * 2 >= win && b.paymentReminderSent !== true) {
      await doc.ref.update({ paymentReminderSent: true });
      reminded++;
      await notify(parent, {
        title: "💳 تذكير بالدفع",
        body: `تذكير بموعد استحقاق الدفع لـ ${b.playerName || "عضو"}. تبقى أقل من نصف مهلة السداد لحجز ${b.sport || ""}، وبعدها سيُلغى تلقائياً!`,
        type: "payment", relatedId: doc.id,
      });
    }
  }
  console.log("bookings cancelled:", cancelled, "reminders:", reminded);
}


// ---------- 4) نظام التقييد (المخالفات) ----------
function hoursFor(kind, level) {
  const base = kind === "monthly" ? 168 : 48;
  const l = Math.min(Math.max(level, 1), 4);
  return base * (1 << (l - 1));
}

async function addStrike(b) {
  const parentId = String(b.parentId || "");
  if (!parentId) return 0;
  const isMonthly = b.category === "monthly";
  const kind = isMonthly ? "monthly" : "individual";
  const created = b.createdAt ? cairo(b.createdAt.toDate()) : cairo();
  const key = isMonthly
    ? `mon_${created.getFullYear()}-${pad(created.getMonth() + 1)}`
    : `ind_${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;

  const ref = db.collection("restrictions").doc(parentId);
  const cur = (await ref.get()).data() || {};
  const strikes = { ...(cur.strikes || {}) };
  const n = (Number(strikes[key]) || 0) + 1;

  if (n >= 2) {
    delete strikes[key];
    const level = (Number(cur[`${kind}Level`]) || 0) + 1;
    const hours = hoursFor(kind, level);
    await ref.set({
      parentId, strikes,
      [`${kind}Level`]: level,
      [`${kind}Until`]: Timestamp.fromDate(new Date(Date.now() + hours * 3600000)),
      [`${kind}Auto`]: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    const days = hours >= 48 ? `${Math.round(hours / 24)} يوم` : `${hours} ساعة`;
    const daysEn = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
    await notify(parentId, {
      title: "⛔ تقييد مؤقت للحجز", titleEn: "⛔ Temporary booking restriction",
      body: isMonthly
        ? `لعدم سداد الاشتراكين الشهريين خلال المهلة قُيِّد حسابك عن الاشتراك الشهري لمدة ${days}.`
        : `لعدم تأكيد/سداد الحجزين خلال المهلة قُيِّد حسابك عن الحجز الفردي وحجز الملاعب لمدة ${days}.`,
      bodyEn: isMonthly
        ? `Because two monthly subscriptions were not paid in time, you are restricted from monthly subscriptions for ${daysEn}.`
        : `Because two bookings were not confirmed/paid in time, you are restricted from individual and court bookings for ${daysEn}.`,
      type: "general",
    });
    return 1;
  }
  strikes[key] = n;
  await ref.set({ parentId, strikes, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return 0;
}

async function processPenalties() {
  const snap = await db.collection("bookings").where("penaltyApplied", "==", false).get();
  let applied = 0;
  for (const d of snap.docs) {
    const b = d.data();
    await d.ref.update({ penaltyApplied: true }); // نعلّم أولًا: لا تُحسب المخالفة مرتين أبدًا
    if (b.cancellationKind === "unpaid_timeout" && b.parentId) applied += await addStrike(b);
  }
  console.log("penalties applied:", applied);
}

async function processMonthlyOverdue() {
  const snap = await db.collection("bookings").where("status", "==", "approvedAwaitingPayment").get();
  let applied = 0;
  for (const d of snap.docs) {
    const b = d.data();
    if (b.category !== "monthly" || b.strike48Counted === true || !b.approvedAt) continue;
    if ((Date.now() - b.approvedAt.toMillis()) / 3600000 < 48) continue;
    await d.ref.update({ strike48Counted: true });
    applied += await addStrike(b);
  }
  console.log("monthly overdue strikes:", applied);
}

// ---------- 5) الدورة الشهرية (التثبيت / التجديد / السداد) ----------
const DAY_AR = { 1: "الاثنين", 2: "الثلاثاء", 3: "الأربعاء", 4: "الخميس", 5: "الجمعة", 6: "السبت", 7: "الأحد" };
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// منتصف الليل بتوقيت القاهرة لتاريخ معيّن (مكوّناته من تاريخ "حائط")
function cairoMidnight(t) {
  const probe = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  const offset = cairo(new Date(probe)).getTime() - probe;
  return new Date(probe - offset);
}

function cycleSelections(b) {
  if (Array.isArray(b.selections) && b.selections.length) return b.selections;
  if (!b.date) return [];
  return [{ startTime: b.startTime, endTime: b.endTime, coachId: b.coachId, coachName: b.coachName, court: b.court, slotId: b.slotId, firstDate: b.date }];
}

function summaryOf(b) {
  const sels = Array.isArray(b.selections) && b.selections.length ? b.selections : cycleSelections(b);
  return sels.map((s) => `${DAY_AR[s.dayOfWeek] || ""} ${s.startTime || ""}`.trim()).join("، ");
}

async function reserveOrCreateSlot(p) {
  const existing = await db.collection("available_slots")
    .where("date", "==", p.date).where("startTime", "==", p.startTime).where("branch", "==", p.branch)
    .limit(1).get();
  if (existing.empty) {
    const ref = await db.collection("available_slots").add({
      sport: p.sport, bookingType: p.bookingType, branch: p.branch, date: p.date,
      startTime: p.startTime, endTime: p.endTime, coachId: p.coachId ?? null, coachName: p.coachName ?? null,
      court: p.court ?? "", capacity: 1, bookedCount: 1,
      bookedPlayers: [{ playerId: p.playerId ?? null, playerName: p.playerName ?? null, bookingId: p.bookingId }],
      isOpen: false, reservedByMonthly: true, createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  }
  const doc = existing.docs[0];
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(doc.ref)).data();
    const cap = d.capacity ?? 1, booked = d.bookedCount ?? 0;
    if (booked >= cap) throw new Error("slot-full");
    const players = [...(d.bookedPlayers || []), { playerId: p.playerId ?? null, playerName: p.playerName ?? null, bookingId: p.bookingId }];
    tx.update(doc.ref, { bookedCount: booked + 1, bookedPlayers: players, ...(booked + 1 >= cap ? { isOpen: false } : {}) });
  });
  return doc.id;
}

async function createNextCycleBooking(doc, anchor, nextMonth, holdEnd) { // يعيد true لو أنشأ حجزًا جديدًا
  const b = doc.data();
  const dup = await db.collection("bookings").where("cycleSourceId", "==", doc.id).where("cycleMonth", "==", nextMonth).limit(1).get();
  if (!dup.empty) return false; // أُنشئ من قبل
  const ref = db.collection("bookings").doc();
  const out = [];
  for (const s of cycleSelections(b)) {
    if (!s.firstDate) continue;
    const orig = cairo(s.firstDate.toDate());
    let t = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    while (t.getDay() !== orig.getDay()) t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    try {
      const slotId = await reserveOrCreateSlot({
        date: ymd(t), startTime: s.startTime || "", endTime: s.endTime || "",
        sport: b.sport || "Squash", bookingType: b.type || "program", branch: b.branch || "sixth",
        coachId: s.coachId, coachName: s.coachName, court: s.court,
        playerId: b.playerId, playerName: b.playerName, bookingId: ref.id,
      });
      out.push({
        dayOfWeek: t.getDay() || 7, startTime: s.startTime ?? null, endTime: s.endTime ?? null,
        coachId: s.coachId ?? null, coachName: s.coachName ?? null, court: s.court ?? null,
        slotId, firstDate: Timestamp.fromDate(cairoMidnight(t)),
      });
    } catch (e) { console.log("slot skipped:", doc.id, e.message); }
  }
  if (!out.length) return false;
  await ref.set({
    playerId: b.playerId ?? null, playerName: b.playerName ?? null, parentId: b.parentId ?? null,
    sport: b.sport ?? null, branch: b.branch || "sixth", type: b.type ?? null,
    category: "monthly", isGroupBooking: true, selections: out,
    programId: b.programId ?? null, programName: b.programName ?? null,
    status: "awaitingConfirmation", isAdminApproved: false,
    cycleMonth: nextMonth, cycleSourceId: doc.id, createdAt: FieldValue.serverTimestamp(),
  });
  await notify(String(b.parentId || ""), {
    title: "📌 ثبّت موعدك الشهري الآن",
    body: `حان وقت تثبيت موعدك المعتاد (${b.sport || "Session"} - ${summaryOf({ selections: out })}) للشهر القادم. لديك حتى نهاية يوم ${holdEnd} قبل أن يُفتح الموعد لغيرك.`,
    type: "schedule", relatedId: ref.id,
  });
  return true;
}

// إلغاء حجز لو حالته ما زالت ضمن المتوقع (يمنع التعارض مع التطبيق)
async function cancelIfStatus(ref, statuses, reason) {
  return db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || !statuses.includes(cur.status)) return null;
    tx.update(ref, { status: "cancelled", cancellationReason: reason, cancelledAt: FieldValue.serverTimestamp() });
    return cur;
  });
}

async function broadcastAll(n) {
  const users = await db.collection("users").get();
  const ids = users.docs.filter((d) => d.data().notificationsMuted !== true).map((d) => d.id);
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + 400)) {
      batch.set(db.collection("notifications").doc(), {
        userId: id, title: n.title, body: n.body, titleEn: n.titleEn, bodyEn: n.bodyEn,
        type: n.type || "general", relatedId: null, viaRelay: true, isRead: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  await pushTo({ included_segments: ["Total Subscriptions"] }, n, "");
}

const PHASE_MSG = {
  hold: { title: "📌 بدأت فترة التثبيت", titleEn: "Hold period started",
    body: 'يمكن للأعضاء الحاليين الاحتفاظ بأماكنهم في الجدول الشهري من تبويب "جدولي".',
    bodyEn: 'Current members can keep their places in the monthly schedule from the "Schedule" tab.' },
  existingEdit: { title: "✏️ فُتح تعديل الجدول للأعضاء الحاليين", titleEn: "Schedule edit opened for members",
    body: "انتهت فترة التثبيت. يمكن للأعضاء الحاليين تعديل مواعيدهم اليوم حسب المتاح.",
    bodyEn: "The hold period ended. Current members can edit their slots today based on availability." },
  openToAll: { title: "✅ فُتح الحجز للجميع", titleEn: "Booking is open to everyone",
    body: "الحجز متاح الآن للأعضاء الجدد والحاليين.", bodyEn: "Booking is now open to new and current members." },
  regular: { title: "📅 بداية دورة جديدة", titleEn: "New cycle started",
    body: "الحجز متاح بشكل عادي.", bodyEn: "Booking is available as usual." },
};

async function runMonthlyCycle() {
  const raw = (await db.collection("system_settings").doc("academy_config").get()).data() || {};
  const dayCfg = (v, f) => {
    const n = typeof v === "number" ? Math.trunc(v) : parseInt(v, 10);
    return Number.isNaN(n) ? f : Math.min(Math.max(n, 1), 28);
  };
  const febShift = typeof raw.februaryShiftDays === "number" ? Math.min(Math.max(Math.trunc(raw.februaryShiftDays), 0), 10) : 3;
  const editWindow = dayCfg(raw.editWindowDays, 1);
  const bookingOpen = raw.bookingOpen !== false;

  const now = cairo();
  const shift = now.getMonth() === 1 ? febShift : 0;
  const eff = (d) => Math.min(Math.max(d - shift, 1), 28);
  const holdStart = eff(dayCfg(raw.holdStartDay, 23));
  const holdEnd = eff(dayCfg(raw.holdEndDay, 24));
  const payDeadline = eff(dayCfg(raw.paymentDeadlineDay, 28));
  const openToAll = holdEnd + editWindow + 1;

  const stateRef = db.collection("system_settings").doc("monthly_cycle_state");
  const state = (await stateRef.get()).data() || {};
  const day = now.getDate();
  const currentMonth = ym(now);
  const anchor = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonth = ym(anchor);
  const todayStr = ymd(now);

  // أ) إنشاء حجوزات "ثبّت موعدك" للشهر القادم
  if (day >= holdStart && day <= holdEnd && state.lastHoldsCreatedMonth !== nextMonth) {
    const snap = await db.collection("bookings")
      .where("category", "==", "monthly").where("cycleMonth", "==", currentMonth).where("status", "==", "confirmed").get();
    let n = 0;
    for (const doc of snap.docs) {
      try { if (await createNextCycleBooking(doc, anchor, nextMonth, holdEnd)) n++; }
      catch (e) { console.log("hold failed", doc.id, e.message); }
    }
    await stateRef.set({ lastHoldsCreatedMonth: nextMonth }, { merge: true });
    console.log("cycle holds created:", n);
  }

  // ب) إلغاء غير المثبّت بعد انتهاء فترة التثبيت
  if (day > holdEnd && state.lastExpiredMonth !== currentMonth) {
    const snap = await db.collection("bookings").where("status", "==", "awaitingConfirmation").get();
    let n = 0;
    for (const doc of snap.docs) {
      const cur = await cancelIfStatus(doc.ref, ["awaitingConfirmation"], `لم يتم التثبيت خلال المهلة المحددة (${holdStart}-${holdEnd})`);
      if (!cur) continue;
      n++;
      await releaseAllSlots(cur, doc.id);
      await notify(String(cur.parentId || ""), {
        title: "❌ انتهت مهلة تثبيت موعدك",
        body: `لم يتم تثبيت موعدك الشهري (${cur.sport || ""} - ${summaryOf(cur)}) في الوقت المحدد، وأصبح متاحاً لغيرك.`,
        type: "cancellation", relatedId: doc.id,
      });
    }
    await stateRef.set({ lastExpiredMonth: currentMonth }, { merge: true });
    console.log("unconfirmed holds cancelled:", n);
  }

  // ج) تذكير السداد قبل آخر موعد بيوم وفي يومه (بعد التاسعة صباحًا)
  if ((day === payDeadline - 1 || day === payDeadline) && now.getHours() >= 9 && state.lastPaymentReminderDate !== todayStr) {
    const snap = await db.collection("bookings")
      .where("status", "==", "approvedAwaitingPayment").where("category", "==", "monthly").get();
    const last = day === payDeadline;
    for (const doc of snap.docs) {
      const b = doc.data();
      await notify(String(b.parentId || ""), {
        title: "💳 تذكير بالدفع",
        body: `تذكير بموعد استحقاق الدفع لـ ${b.playerName || "عضو"}. ` + (last
          ? `اليوم آخر موعد لسداد ورفع إيصال حجز ${b.sport || ""} الشهري!`
          : `برجاء سداد ورفع إيصال حجز ${b.sport || ""} الشهري قبل نهاية الشهر.`),
        type: "payment", relatedId: doc.id,
      });
    }
    await stateRef.set({ lastPaymentReminderDate: todayStr }, { merge: true });
    console.log("payment reminders sent:", snap.size);
  }

  // د) إلغاء غير المسدد بعد آخر موعد للسداد
  if (day > payDeadline && state.lastMonthlyPaymentExpiredMonth !== currentMonth) {
    let n = 0;
    // ملاحظة: الحجز الذي رُفع له إيصال (paymentSubmitted) لا يُلغى أبدًا بسبب تأخر مراجعة الأدمن.
    // يُلغى فقط ما لم يُرفع له إيصال (approvedAwaitingPayment). ورفض الإيصال يغيّر الحالة إلى rejected.
    for (const st of ["approvedAwaitingPayment"]) {
      const snap = await db.collection("bookings").where("status", "==", st).where("category", "==", "monthly").get();
      for (const doc of snap.docs) {
        const cur = await cancelIfStatus(doc.ref, [st], `لم يتم استكمال السداد قبل نهاية يوم ${payDeadline}`);
        if (!cur) continue;
        n++;
        await releaseAllSlots(cur, doc.id);
        await notify(String(cur.parentId || ""), {
          title: "❌ تم إلغاء حجزك",
          body: `تم إلغاء حجزك الشهري (${cur.sport || ""} - ${summaryOf(cur)}) لعدم استكمال السداد قبل نهاية يوم ${payDeadline}.`,
          type: "cancellation", relatedId: doc.id,
        });
      }
    }
    await stateRef.set({ lastMonthlyPaymentExpiredMonth: currentMonth }, { merge: true });
    console.log("monthly unpaid cancelled:", n);
  }

  // هـ) إشعار عام عند تغيّر مرحلة الدورة
  const phase = day < holdStart ? "regular" : day <= holdEnd ? "hold" : day < openToAll ? "existingEdit" : "openToAll";
  const phaseKey = `${currentMonth}:${phase}`;
  if (state.lastPhaseKey !== phaseKey) {
    await stateRef.set({ lastPhaseKey: phaseKey }, { merge: true });
    if (state.lastPhaseKey != null && bookingOpen) {
      await broadcastAll({ ...PHASE_MSG[phase], type: "schedule" });
      console.log("phase broadcast:", phase);
    }
  }
}


// ---------- 6) نظام البدلاء (الاعتذار والتبديل) ----------
const OFFERS = "replacement_offers";
const SPORT_AR = { Squash: "اسكواش", "Table Tennis": "تنس الطاولة", Fitness: "لياقة بدنية" };
const PERIODS = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440] };

function minutesOf(t) {
  const m = /(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/.exec(String(t || ""));
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + min;
}

function parseYmd(s) {
  const p = String(s || "").split("-");
  if (p.length !== 3) return null;
  const [y, m, d] = p.map((x) => parseInt(x, 10));
  if ([y, m, d].some(Number.isNaN)) return null;
  return new Date(y, m - 1, d);
}

// عدد الأيام بين اليوم (بتوقيت القاهرة) وتاريخ التمرينة، أو null لو التاريخ غير صالح
function daysFromToday(dateStr) {
  const d = parseYmd(dateStr);
  if (!d) return null;
  const n = cairo();
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000);
}

async function notifyCoach(coachDocId, title, body) {
  if (!coachDocId) return;
  try {
    const c = await db.collection("coaches").doc(coachDocId).get();
    const uid = String((c.data() || {}).userId || "");
    if (uid) await notify(uid, { title, body, type: "schedule" });
  } catch (e) { console.log("notifyCoach failed", e.message); }
}

// تغيير حالة العرض بشكل ذرّي فقط لو ما زالت الحالة المتوقعة (يمنع التنفيذ المزدوج)
async function claimOffer(ref, expected, updates) {
  return db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || cur.status !== expected) return false;
    tx.update(ref, updates);
    return true;
  });
}

// إشعار قائمة الانتظار بموعد شاغر مطابق لتفضيلاتهم
async function notifyWaitlistMatches(slots) {
  if (!slots.length) return 0;
  const sport = String(slots[0].sport || "");
  const snap = await db.collection("waitlist").where("sport", "==", sport).get();
  let sent = 0;
  for (const d of snap.docs) {
    const w = d.data();
    if (w.status !== "waiting") continue;
    const wBranch = String(w.branch || ""), wType = String(w.bookingType || ""), wCoach = String(w.coachId || "");
    const wDays = (w.weekdays || []).map(Number);
    const wPeriods = (w.periods || []).map(String);
    let hit = null;
    for (const s of slots) {
      if (wBranch && String(s.branch || "") !== wBranch) continue;
      if (wType && String(s.bookingType || "") !== wType) continue;
      if (wCoach && String(s.coachId || "") !== wCoach) continue;
      const dt = parseYmd(s.date);
      if (!dt) continue;
      if (wDays.length && !wDays.includes(dt.getDay() || 7)) continue;
      if (wPeriods.length) {
        const m = minutesOf(s.startTime);
        if (!wPeriods.some((p) => PERIODS[p] && m >= PERIODS[p][0] && m < PERIODS[p][1])) continue;
      }
      hit = s;
      break;
    }
    if (!hit) continue;
    const claimed = await db.runTransaction(async (tx) => {
      const c = (await tx.get(d.ref)).data();
      if (!c || c.status !== "waiting") return false;
      tx.update(d.ref, { status: "notified", notifiedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) continue;
    const summary = `${hit.date} ${hit.startTime || ""}`;
    const name = String(w.playerName || "");
    await notify(String(w.parentId || ""), {
      title: "⭐ توفّر موعدك المفضل", titleEn: "Your preferred slot is available",
      body: `توفّر موعد مناسب لتفضيلاتك (${SPORT_AR[sport] || "اسكواش"} - ${name}): ${summary}. اضغط لإضافته وحجزه قبل أن يُحجز.`,
      bodyEn: `A slot matching your preferences is now available (${sport} - ${name}): ${summary}. Tap to add and book it before it is taken.`,
      type: "schedule", action: "book",
      relatedId: `${sport}|${hit.date || ""}|${hit.bookingType || "individualTraining"}|${hit.branch || ""}`,
    });
    sent++;
  }
  return sent;
}

// إنهاء حجز الموعد المؤقت للتبديل وإبلاغ قائمة الانتظار
async function publishSlot(o) {
  const sid = String(o.slotId || "");
  if (!sid) return;
  const ref = db.collection("available_slots").doc(sid);
  const sd = (await ref.get()).data();
  if (!sd) return;
  if (sd.swapHoldUntil != null) await ref.update({ swapHoldUntil: FieldValue.delete() });
  const cap = Number(sd.capacity ?? 1), booked = Number(sd.bookedCount ?? 0);
  if (booked < cap && sd.isOpen !== false) await notifyWaitlistMatches([{ ...sd, id: sid }]);
}

async function rankedCandidates(sport, excludeParentId, excludePlayerId, pts) {
  const snap = sport ? await db.collection("players").where("sport", "==", sport).get() : await db.collection("players").get();
  const list = [];
  for (const d of snap.docs) {
    const m = d.data();
    const parent = String(m.parentId || "");
    if (!parent || d.id === excludePlayerId || (excludeParentId && parent === excludeParentId && !excludePlayerId)) continue;
    list.push({
      playerId: d.id, parentId: parent,
      playerName: `${m.firstName || ""} ${m.lastName || ""}`.trim(),
      points: pts[parent] || 0,
    });
  }
  list.sort((a, b) => b.points - a.points);
  return list.slice(0, 30);
}

async function pointsByParent() {
  const snap = await db.collection("apology_points").get();
  const out = {};
  for (const d of snap.docs) {
    const m = d.data();
    const pid = String(m.parentId || "");
    if (pid) out[pid] = (out[pid] || 0) + (Number(m.points) || 0);
  }
  return out;
}

// أ) عروض جديدة: بناء قائمة المرشحين بالنقاط وإبلاغ الأدمن
async function buildPendingOffers() {
  const snap = await db.collection(OFFERS).where("status", "==", "pending").get();
  if (snap.empty) return;
  const pts = await pointsByParent();
  for (const doc of snap.docs) {
    const o = doc.data();
    const queue = await rankedCandidates(String(o.sport || ""), String(o.apologizerParentId || ""), String(o.apologizerPlayerId || ""), pts);
    if (!queue.length) {
      if (await claimOffer(doc.ref, "pending", { status: "closed", publicOpened: true })) await publishSlot(o);
      continue;
    }
    if (!(await claimOffer(doc.ref, "pending", { status: "open", queue }))) continue;
    await notifyAdmins({
      title: "اقتراح بديل لموعد شاغر", titleEn: "Replacement suggestion for a free slot",
      body: `اعتذر ${o.apologizerName} عن تمرينة ${o.date} ${o.startTime}. النظام يقترح ${queue[0].playerName} (${queue[0].points} نقطة). افتح "البدلاء بالنقاط" للاعتماد.`,
      bodyEn: `${o.apologizerName} apologized for ${o.date} ${o.startTime}. Suggested: ${queue[0].playerName} (${queue[0].points} pts). Open "Replacements".`,
      type: "booking",
    });
  }
}

// ب) انتهاء مهلة التبديل: الموعد يُفتح للحجز الفردي وتُبلَّغ قائمة الانتظار (مرة واحدة)
async function openExpiredHolds() {
  const ACTIVE = ["pending", "open", "offered", "accepted", "rejected"];
  const snap = await db.collection(OFFERS).where("status", "in", ACTIVE).get();
  for (const doc of snap.docs) {
    const o0 = doc.data();
    if (o0.publicOpened === true) continue;
    if (o0.openAt && o0.openAt.toMillis && o0.openAt.toMillis() > Date.now()) continue;
    const o = await db.runTransaction(async (tx) => {
      const c = (await tx.get(doc.ref)).data();
      if (!c || c.publicOpened === true || !ACTIVE.includes(c.status)) return null;
      if (c.openAt && c.openAt.toMillis && c.openAt.toMillis() > Date.now()) return null;
      tx.update(doc.ref, { publicOpened: true });
      return c;
    });
    if (!o) continue;
    try {
      const sid = String(o.slotId || "");
      if (!sid) continue;
      const sd = (await db.collection("available_slots").doc(sid).get()).data();
      if (!sd) continue;
      const cap = Number(sd.capacity ?? 1), booked = Number(sd.bookedCount ?? 0);
      if (booked >= cap || sd.isOpen === false) continue;
      await notifyWaitlistMatches([{ ...sd, id: sid }]);
      if (o.status !== "accepted") {
        await notifyAdmins({
          title: "فُتح الموعد للحجز الفردي", titleEn: "Slot opened for individual booking",
          body: `انتهت مهلة التبديل لموعد ${o.date} ${o.startTime}؛ أصبح متاحاً للحجز الفردي بالتوازي مع الترشيح.`,
          bodyEn: `The swap window for ${o.date} ${o.startTime} ended; the slot is now open for individual booking in parallel with the nomination.`,
          type: "booking",
        });
      }
    } catch (e) { console.log("open hold failed", doc.id, e.message); }
  }
}

// ج) تنفيذ ردود المرشحين (قبول / رفض)
async function applyReplacementDecisions() {
  const snap = await db.collection(OFFERS).where("status", "in", ["accepted", "rejected"]).get();
  for (const doc of snap.docs) {
    try { await applyDecision(doc); } catch (e) { console.log("decision failed", doc.id, e.message); }
  }
}

async function applyDecision(doc) {
  const o = doc.data();
  const queue = Array.isArray(o.queue) ? o.queue : [];
  const idx = Number.isFinite(Number(o.index)) ? Math.trunc(Number(o.index)) : 0;
  if (idx < 0 || idx >= queue.length) { await claimOffer(doc.ref, o.status, { status: "closed" }); return; }
  const c = queue[idx];
  const cName = String(c.playerName), cParent = String(c.parentId), cPlayer = String(c.playerId);

  // الرفض: القرار يرجع للأدمن ليختار مرشحًا آخر
  if (o.status === "rejected") {
    const declined = [...(o.declinedIds || []).map(String), cPlayer];
    if (!(await claimOffer(doc.ref, "rejected", { status: "open", currentParentId: "", declinedIds: declined }))) return;
    await notifyAdmins({
      title: "اعتذر المرشح عن البديل", titleEn: "Candidate declined the replacement",
      body: `رفض ${cName} موعد ${o.date} ${o.startTime}. اختر مرشحاً آخر من "البدلاء بالنقاط".`,
      bodyEn: `${cName} declined ${o.date} ${o.startTime}. Pick another candidate in "Replacements".`,
      type: "booking",
    });
    return;
  }

  // القبول: نافذة تعديل الجدول الثابت = يوم التدريب أو قبله بيوم واحد فقط
  const diff = daysFromToday(String(o.date || ""));
  if (diff === null || diff < 0) {
    if (await claimOffer(doc.ref, "accepted", { status: "closed", currentParentId: "", closedReason: "date_passed" })) {
      await notifyAdmins({
        title: "تعذّر التبديل", titleEn: "Swap could not be completed",
        body: `قبل ${cName} الترشيح لكن موعد ${o.date} ${o.startTime} مضى قبل تنفيذ التبديل.`,
        bodyEn: `${cName} accepted but the ${o.date} ${o.startTime} session had already passed.`,
        type: "booking",
      });
    }
    return;
  }
  if (diff > 1) return; // لم تفتح نافذة التعديل بعد، يُعاد الفحص في التشغيل القادم

  const sid = String(o.slotId || "");
  const bookingId = `repl_${doc.id}`;

  // 1) حجز المقعد + علامة reserved في عملية ذرّية واحدة (لا يُحجز مرتين أبدًا)
  const reserved = await db.runTransaction(async (tx) => {
    const cur = (await tx.get(doc.ref)).data();
    if (!cur || cur.status !== "accepted") return "skip";
    if (!sid || cur.reserved === true) return "ok";
    const slotRef = db.collection("available_slots").doc(sid);
    const ss = await tx.get(slotRef);
    if (!ss.exists) return "taken";
    const sd = ss.data();
    const cap = Number(sd.capacity ?? 1), booked = Number(sd.bookedCount ?? 0);
    if (sd.isOpen === false || booked >= cap) return "taken";
    const players = [...(sd.bookedPlayers || []), { playerId: cPlayer, playerName: cName, bookingId }];
    tx.update(slotRef, {
      bookedCount: booked + 1, bookedPlayers: players, swapHoldUntil: FieldValue.delete(),
      ...(booked + 1 >= cap ? { isOpen: false } : {}),
    });
    tx.update(doc.ref, { reserved: true });
    return "ok";
  });
  if (reserved === "skip") return;

  if (reserved === "taken") {
    if (!(await claimOffer(doc.ref, "accepted", { status: "closed", currentParentId: "", closedReason: "slot_taken" }))) return;
    await notify(cParent, {
      title: "الموعد لم يعد متاحاً", titleEn: "The slot is no longer available",
      body: `عذراً، حُجز موعد ${o.date} ${o.startTime} من لاعب آخر قبل إتمام التبديل.`,
      bodyEn: `Sorry, the ${o.date} ${o.startTime} slot was booked by someone else before the swap was completed.`,
      type: "booking",
    });
    await notifyAdmins({
      title: "تعذّر التبديل", titleEn: "Swap could not be completed",
      body: `قبل ${cName} الترشيح لكن الموعد ${o.date} ${o.startTime} حُجز فردياً قبل التنفيذ.`,
      bodyEn: `${cName} accepted but the ${o.date} ${o.startTime} slot was booked individually first.`,
      type: "booking",
    });
    return;
  }

  // 2) إضافة اللاعب لجدول ذلك اليوم فقط + إنهاء العرض (ذرّيًا، ومعرّف ثابت يمنع التكرار)
  const ovRef = db.collection("daily_overrides").doc(bookingId);
  const done = await db.runTransaction(async (tx) => {
    const cur = (await tx.get(doc.ref)).data();
    if (!cur || cur.status !== "accepted") return false;
    tx.set(ovRef, {
      type: "add", date: String(o.date || ""), createdBy: "admin",
      bookingId: null, slotId: null,
      playerId: cPlayer, playerName: cName, parentId: cParent,
      sport: String(o.sport || ""), branch: String(o.branch || ""),
      coachDocId: String(o.coachDocId || ""), coachName: String(o.coachName || ""),
      startTime: String(o.startTime || ""), endTime: String(o.endTime || ""),
      toDate: null, toStartTime: null, toEndTime: null, toCoachDocId: "", toCoachName: null,
      note: "بديل بالنقاط", inParentId: "", createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(doc.ref, { status: "done", doneAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!done) return;

  const text = `تمت إضافة ${cName} إلى تدريب يوم ${o.date} الساعة ${o.startTime || ""} ليوم واحد.\nملاحظة: بديل بالنقاط`;
  await notify(cParent, { title: "تعديل في موعد تدريب", body: text, type: "schedule" });
  await notifyCoach(String(o.coachDocId || ""), "تعديل في جدول اليوم", text);
  await notifyAdmins({
    title: "تم قبول الترشيح", titleEn: "Nomination accepted",
    body: `${cName} قبل التمرينة وأُضيف لجدول ${o.date} فقط.`,
    bodyEn: `${cName} accepted and was added to ${o.date} only.`,
    type: "booking",
  });
}

async function sweepReplacements() {
  await buildPendingOffers();
  await openExpiredHolds();
  await applyReplacementDecisions();
}

async function withRetry(job, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try { await job(); return null; }
    catch (e) {
      console.error(`${job.name} attempt ${i}/${tries} failed:`, e.message);
      if (i === tries) return e;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

// وضع الفحص: يقرأ فقط ويطبع تقريرًا، بدون أي تعديل على البيانات ولا إرسال إشعارات
async function checkMode() {
  console.log("=== وضع الفحص (لا يتم تعديل أي بيانات) ===");
  const cnt = async (col, f, op, v) => (await db.collection(col).where(f, op, v).get()).size;
  const cfg = await db.collection("system_settings").doc("academy_config").get();
  console.log("إعدادات الأكاديمية (academy_config):", cfg.exists ? "موجودة ✅" : "غير موجودة (ستُستخدم القيم الافتراضية) ⚠️");
  console.log("أسرار OneSignal:", process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_KEY ? "موجودة ✅" : "ناقصة ⚠️ (لن تصل إشعارات Push، وستظهر داخل التطبيق فقط)");
  console.log("عدد الأدمن المستلمين للتنبيهات:", (await db.collection("users").where("role", "in", ["admin", "technicalManager"]).get()).size);
  console.log("طلبات متجر في طابور البائعين:", await cnt("shop_orders", "fwdState", "==", "active"));
  console.log("طلبات متجر بانتظار السداد:", await cnt("shop_orders", "status", "==", "approvedAwaitingPayment"));
  console.log("حجوزات بانتظار السداد:", await cnt("bookings", "status", "==", "approvedAwaitingPayment"));
  console.log("حجوزات بانتظار التثبيت:", await cnt("bookings", "status", "==", "awaitingConfirmation"));
  console.log("حجوزات إيصالها بانتظار مراجعة الأدمن (لن تُلغى):", await cnt("bookings", "status", "==", "paymentSubmitted"));
  for (const st of ["pending", "open", "accepted", "rejected"]) console.log(`عروض بدلاء بحالة ${st}:`, await cnt("replacement_offers", "status", "==", st));
  console.log("قائمة الانتظار (waiting):", await cnt("waitlist", "status", "==", "waiting"));
  console.log("=== انتهى الفحص بنجاح ✅ ===");
}

(async () => {
  if (process.env.MODE === "check") { await checkMode(); return; }
  const jobs = [sweepVendorQueue, deleteUnpaidShopOrders, expireUnpaidBookings, processPenalties, processMonthlyOverdue, runMonthlyCycle, sweepReplacements];
  const failed = [];
  for (const job of jobs) {
    const err = await withRetry(job);
    if (err) failed.push(`${job.name}: ${err.message}`.slice(0, 200));
  }
  // نبض التشغيل: تقدر تراجع system_settings/automation_status لتتأكد أن السكربت يعمل
  try {
    await db.collection("system_settings").doc("automation_status").set({
      lastRunAt: FieldValue.serverTimestamp(), ok: failed.length === 0, failedJobs: failed,
      ...(failed.length === 0 ? { lastSuccessAt: FieldValue.serverTimestamp() } : {}),
    }, { merge: true });
  } catch (e) { console.error("heartbeat failed:", e.message); }
  if (failed.length) { console.error("FAILED JOBS:", failed); process.exitCode = 1; }
})();
