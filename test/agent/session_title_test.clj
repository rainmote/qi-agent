(ns agent.session-title-test
  (:require [agent.kernel :as kernel]
            [agent.plugin :as plugin]
            [agent.plugins.session-title :as session-title]
            [clojure.test :refer [deftest is testing]]))

(deftest titles-are-clean-compact-and-deterministic
  (is (= "优化 Web 输入框交互"
         (session-title/title-from-message
          {:role "user"
           :content "/goal 请帮我优化 Web 输入框交互。并补齐测试"})))
  (is (= "分析 图片"
         (session-title/title-from-message
          {:role "user"
           :content [{:type "text" :text "请分析"}
                     {:type "image" :url "data:image/png;base64,AA=="}]})))
  (is (= "1234567…"
         (session-title/title-from-message
          {:role "user" :content "1234567890"} 8))))

(deftest plugin-names-only-an-untitled-completed-conversation
  (let [ctx (plugin/boot!
             {:plugins [{:ns 'agent.plugins.session}
                        {:ns 'agent.plugins.session-title}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)]
        ((:append! store) "message"
         {:message {:role "user" :content "请帮我修复登录状态同步问题"}})

        (testing "an intermediate tool-call response is not a completed turn"
          (kernel/emit! ctx :agent.message/end
                        {:message {:role "assistant"
                                   :tool_calls [{:id "call-1"}]}})
          (is (nil? ((:name store)))))

        (testing "the first final assistant response assigns the title"
          (kernel/emit! ctx :agent.message/end
                        {:message {:role "assistant" :content "已修复。"}})
          (is (= "修复登录状态同步问题" ((:name store))))
          (is (= 1 (count (filter #(= "session/name" (:type %))
                                 ((:events store)))))))

        (testing "later turns never replace the first automatic title"
          (kernel/emit! ctx :agent.message/end
                        {:message {:role "assistant" :content "继续完成。"}})
          (is (= "修复登录状态同步问题" ((:name store))))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest default-agent-loop-triggers-automatic-title
  (let [ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.session}
               {:ns 'agent.plugins.session-title}
               {:ns 'agent.plugins.mock
                :config {:responses
                         [{:message {:role "assistant" :content "完成"}
                           :finish-reason "stop"}]}}
               {:ns 'agent.plugins.runtime}]})]
    (try
      ((kernel/require-service ctx :agent/run) "请检查缓存失效策略")
      (is (= "检查缓存失效策略"
             ((:name (kernel/require-service ctx :session/store)))))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest manual-names-win-and-existing-turns-are-recovered
  (testing "a manual name is never overwritten"
    (let [ctx (plugin/boot!
               {:plugins [{:ns 'agent.plugins.session}
                          {:ns 'agent.plugins.session-title}]})]
      (try
        (let [store (kernel/require-service ctx :session/store)]
          ((:append! store) "message"
           {:message {:role "user" :content "排查支付超时"}})
          ((:name! store) "支付专项")
          (kernel/emit! ctx :agent.message/end
                        {:message {:role "assistant" :content "完成"}})
          (is (= "支付专项" ((:name store)))))
        (finally
          (kernel/dispose-all! ctx)))))

  (testing "loading the plugin recovers an old complete untitled session"
    (let [ctx (plugin/boot! {:plugins [{:ns 'agent.plugins.session}]})]
      (try
        (let [store (kernel/require-service ctx :session/store)]
          ((:append! store) "message"
           {:message {:role "user" :content "整理发布流程"}})
          ((:append! store) "message"
           {:message {:role "assistant" :content "已整理"}})
          (plugin/load-plugin! ctx {:ns 'agent.plugins.session-title})
          (is (= "整理发布流程" ((:name store)))))
        (finally
          (kernel/dispose-all! ctx))))))
