"use client";

import type React from "react";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Mail, Phone, MapPin, Send, Loader2 } from "lucide-react";
import { useMetaTracking } from "@/hooks/useMetaTracking";

interface FormData {
  name: string;
  email: string;
  subject: string;
  message: string;
  language: "en" | "zh";
}

export function ContactForm() {
  const [formData, setFormData] = useState<FormData>({
    name: "",
    email: "",
    subject: "",
    message: "",
    language: "zh",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const { trackLead } = useMetaTracking();

  const handleInputChange = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...formData,
          timestamp: new Date().toISOString(),
        }),
      });

      if (response.ok) {
        // Meta Pixel 雙層追蹤 - Lead
        await trackLead(
          undefined,
          'TWD',
          {
            email: formData.email,
          }
        );

        toast({
          title: "Message Sent Successfully",
          description:
            "Thank you for your message. We'll get back to you soon!",
        });
        setFormData({
          name: "",
          email: "",
          subject: "",
          message: "",
          language: "en",
        });
      } else {
        throw new Error("Failed to send message");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send message. Please try again later.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid gap-6 sm:gap-8 lg:grid-cols-2">
      {/* Contact Form */}
      <Card className="border-0 bg-card/50 backdrop-blur lg:row-span-2">
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="font-heading text-xl sm:text-2xl">
            傳送訊息
          </CardTitle>
          <p className="text-muted-foreground text-sm sm:text-base">
            有任何疑問或想進一步了解 Thinker Cafe？和我們聊聊吧！
          </p>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 pt-0">
          <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-sm">
                  姓名
                </Label>
                <Input
                  id="name"
                  type="text"
                  placeholder="姓名"
                  value={formData.name}
                  onChange={(e) => handleInputChange("name", e.target.value)}
                  required
                  className="bg-background/50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm">
                  信箱
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="your.email@example.com"
                  value={formData.email}
                  onChange={(e) => handleInputChange("email", e.target.value)}
                  required
                  className="bg-background/50"
                />
              </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="subject" className="text-sm">
                類別
              </Label>
              <Select
                value={formData.subject}
                onValueChange={(value) => handleInputChange("subject", value)}
              >
                <SelectTrigger className="w-full bg-background/50">
                  <SelectValue placeholder="請選擇" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="General Inquiry">
                    一般詢問
                  </SelectItem>
                  <SelectItem value="Product Information">
                    課程資訊
                  </SelectItem>
                  <SelectItem value="Partnership Opportunities">
                    合作機會
                  </SelectItem>
                  <SelectItem value="Feedback & Suggestions">
                    意見回饋
                  </SelectItem>
                  <SelectItem value="Customer Support">
                    售後服務
                  </SelectItem>
                  <SelectItem value="Other">其他</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="message" className="text-sm">
                訊息
              </Label>
              <Textarea
                id="message"
                placeholder="告訴我們更多資訊⋯⋯"
                value={formData.message}
                onChange={(e) => handleInputChange("message", e.target.value)}
                required
                rows={4}
                className="bg-background/50 resize-none"
              />
            </div>
            {/*
            <div className="space-y-2">
              <Label htmlFor="language" className="text-sm">
                偏好語言
              </Label>
              <Select
                value={formData.language}
                onValueChange={(value: "en" | "zh") =>
                  handleInputChange("language", value)
                }
              >
                <SelectTrigger className="w-full bg-background/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh">中文</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
            */}
            <Button
              type="submit"
              className=" max-w-6xl bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white border-0 hover-lift hover-glow bg-gradient-animate flex sm:col-span-2"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  傳送中...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  傳送訊息
                </>
              )}
            </Button>
            </div>
          </form>
        </CardContent>
      </Card>

        <Card className="border-0 bg-card/50 backdrop-blur">
          <CardContent className="p-4 sm:p-6">
            <h3 className="font-heading text-lg sm:text-xl font-semibold mb-4">
              聯絡方式
            </h3>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                  <Mail className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-sm sm:text-base">信箱</p>
                  <p className="text-xs sm:text-sm text-muted-foreground break-all">
                    cruz@thinker.cafe
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-accent/10 flex-shrink-0">
                  <Phone className="h-4 w-4 sm:h-5 sm:w-5 text-accent" />
                </div>
                <div>
                  <p className="font-medium text-sm sm:text-base">電話</p>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    {" "}
                    +886 937431998
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0 mt-0.5">
                  <MapPin className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium text-sm sm:text-base">地址</p>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    106 台北市大安區
                    <br />
                    信義路四段170號3樓
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 bg-card/50 backdrop-blur">
          <CardContent className="p-4 sm:p-6">
            <h3 className="font-heading text-lg sm:text-xl font-semibold mb-4">
              服務時間
            </h3>
            <div className="space-y-2 text-xs sm:text-sm">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">週一至週五</span>
                <span className="font-medium">7:00 AM - 9:00 PM</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">週六</span>
                <span className="font-medium">8:00 AM - 10:00 PM</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">週日</span>
                <span className="font-medium">8:00 AM - 8:00 PM</span>
              </div>
            </div>
          </CardContent>
        </Card>
    </div>
  );
}
