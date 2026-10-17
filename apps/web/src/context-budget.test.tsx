import assert from "node:assert/strict";
import test from "node:test";
import { contextBudgetExplanation } from "./context-budget";
import type { ContextStatus } from "./types";

const status: ContextStatus = {used_tokens:112000,context_window:128000,percent:88,system_tokens:0,tool_tokens:0,message_tokens:112000,
  basis:"next-request",reserve_tokens:16384,input_limit:111616,option_tokens:0,fits:false};
test("input budget accounts for the answer reserve before the whole window fills",()=>{
  const text=contextBudgetExplanation(status);
  for(const value of ["下一请求","16,384","111,616","请求选项 0","超过输入预算"])assert.ok(text.includes(value),value);
  assert.ok(contextBudgetExplanation({...status,used_tokens:0,fits:true}).includes("在输入预算内"));
  assert.ok(contextBudgetExplanation({...status,basis:"last-request"}).includes("上一请求为回答预留"));
});
test("missing legacy budget fields and invalid tokens remain unknown",()=>{
  const {basis,reserve_tokens,input_limit,option_tokens,fits,...legacy}=status;
  const text=contextBudgetExplanation({...legacy,used_tokens:0});
  assert.match(text,/估算输入 0/);assert.match(text,/口径未知/);assert.match(text,/预留未知/);
  for(const used_tokens of [NaN,-1,Infinity])assert.match(contextBudgetExplanation({...status,used_tokens}),/估算输入 未知/);
  assert.match(contextBudgetExplanation({...status,fits:true}),/是否符合输入预算未知/);
  assert.match(contextBudgetExplanation({...status,context_window:0}),/是否符合输入预算未知/);
});
