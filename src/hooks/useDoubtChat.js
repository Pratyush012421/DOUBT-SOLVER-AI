import { useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { upsertDoubt } from "@/lib/doubtStore";

const AGENT_NAME = "doubt_solver";
const BUSY = ["pending", "running", "in_progress"];

// Context prefix sent to the agent so it knows the selected chapter scope.
const CONTEXT_PREFIX = (ch) =>
  `[Selected chapter: ${ch.class_level} · ${ch.subject} · Chapter ${ch.chapter_number}: ${ch.title}]\n\n`;

// Strip the context prefix when rendering, so the chat bubble shows only the question.
const stripContext = (content) =>
  String(content || "").replace(/^\[Selected chapter:.*?\]\n\n/s, "");

export default function useDoubtChat(chapter, existing) {
  const [messages, setMessages] = useState(existing?.messages || []);
  const [thinking, setThinking] = useState(false);
  const conversationRef = useRef(null);
  const conversationPromiseRef = useRef(null);
  const doubtRef = useRef(null);
  const messagesRef = useRef(existing?.messages || []);
  const awaitingRef = useRef(false);
  const expectedRef = useRef(0);

  const commit = (next) => {
    messagesRef.current = next;
    setMessages(next);
    const doubt = doubtRef.current;
    const question = next.find((m) => m.role === "user")?.content;
    if (doubt && question && chapter) {
      upsertDoubt({
        id: doubt.id,
        conversation_id: doubt.conversation_id,
        class_level: chapter.class_level,
        subject: chapter.subject,
        chapter_number: chapter.chapter_number,
        chapter_title: chapter.title,
        question,
        messages: next,
        updated_date: Date.now(),
      });
    }
  };

  // History load takes both roles; live updates only carry the agent's replies.
  const mergeMessages = (raw, replace = false) => {
    const list = Array.isArray(raw) ? raw : [];
    const incoming = list
      .filter((m) => (replace || m.role === "assistant") && String(m.content || "").trim())
      .map((m, i) => ({ id: m.id || `${m.role}-${i}`, role: m.role, content: stripContext(m.content) }));

    const next = replace ? [] : [...messagesRef.current];
    incoming.forEach((m) => {
      const at = next.findIndex((x) => x.id === m.id);
      if (at === -1) next.push(m);
      else next[at] = m;
    });

    const busy = list.some((m) => (m.tool_calls || []).some((tc) => BUSY.includes(tc.status)));
    const answered = next.filter((m) => m.role === "assistant").length;
    if (awaitingRef.current && answered >= expectedRef.current && !busy) awaitingRef.current = false;
    if (!replace) setThinking(busy || awaitingRef.current);
    commit(next);
  };

  useEffect(() => {
    if (!chapter) return;
    let cancelled = false;
    let unsubscribe;

    doubtRef.current = existing
      ? { id: existing.id, conversation_id: existing.conversation_id }
      : { id: crypto.randomUUID(), conversation_id: null };
    conversationRef.current = null;
    messagesRef.current = existing?.messages || [];
    setMessages(existing?.messages || []);
    awaitingRef.current = false;
    setThinking(false);

    const openConversation = async () => {
      if (existing?.conversation_id) {
        const loaded = await base44.agents.getConversation(existing.conversation_id);
        const conversation = loaded?.data ?? loaded;
        if (cancelled) return conversation;
        conversationRef.current = conversation;
        mergeMessages(conversation.messages, true);
        unsubscribe = base44.agents.subscribeToConversation(conversation.id, (data) => mergeMessages(data?.messages));
        return conversation;
      }

      const created = await base44.agents.createConversation({
        agent_name: AGENT_NAME,
        metadata: {
          name: `${chapter.class_level} · ${chapter.subject} · Chapter ${chapter.chapter_number}`,
          description: `Doubt session for ${chapter.title}`,
          class_level: chapter.class_level,
          subject: chapter.subject,
          chapter_number: String(chapter.chapter_number || ""),
          chapter_title: chapter.title,
        },
      });
      const conversation = created?.data ?? created;
      if (cancelled) return conversation;
      conversationRef.current = conversation;
      doubtRef.current.conversation_id = conversation.id;
      unsubscribe = base44.agents.subscribeToConversation(conversation.id, (data) => mergeMessages(data?.messages));
      return conversation;
    };

    conversationPromiseRef.current = openConversation().catch(() => null);

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [chapter?.class_level, chapter?.subject, chapter?.chapter_number, chapter?.title, existing?.id]);

  const send = async (question) => {
    awaitingRef.current = true;
    expectedRef.current = messagesRef.current.filter((m) => m.role === "assistant").length + 1;
    setThinking(true);
    commit([...messagesRef.current, { id: `local-${Date.now()}`, role: "user", content: question }]);
    try {
      const conversation = conversationRef.current || (await conversationPromiseRef.current);
      if (!conversation) throw new Error("Conversation unavailable");
      await base44.agents.addMessage(conversation, {
        role: "user",
        content: chapter ? `${CONTEXT_PREFIX(chapter)}${question}` : question,
      });
    } catch (error) {
      awaitingRef.current = false;
      setThinking(false);
      commit([
        ...messagesRef.current,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: "The research agent didn't answer this time. Please send your doubt again.",
        },
      ]);
    }
  };

  return { messages, thinking, send };
