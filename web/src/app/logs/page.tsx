"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { DateRangeFilter } from "@/components/date-range-filter";
import { ImageLightbox } from "@/components/image-lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchSystemLogs, type SystemLog } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const LogType = {
  Call: "call",
  Account: "account",
} as const;

const typeLabels: Record<string, string> = {
  [LogType.Call]: "调用日志",
  [LogType.Account]: "账号管理日志",
};

function getDetailText(item: SystemLog, key: string) {
  const value = item.detail?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "-";
}

function formatDuration(item: SystemLog) {
  const value = item.detail?.duration_ms;
  return typeof value === "number" ? `${(value / 1000).toFixed(2)} s` : "-";
}

function getUrls(item: SystemLog | null) {
  const urls = item?.detail?.urls;
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
}

function getStatus(item: SystemLog) {
  const status = item.detail?.status;
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return "-";
}

function LogsContent({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<SystemLog[]>([]);
  const [type, setType] = useState<(typeof LogType)[keyof typeof LogType]>(LogType.Call);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [detailLog, setDetailLog] = useState<SystemLog | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const detailUrls = getUrls(detailLog);
  const detailImages = detailUrls.map((url, index) => ({ id: `${index}`, src: url }));
  const effectiveType = isAdmin ? type : LogType.Call;
  const isCallLog = effectiveType === LogType.Call;
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const currentRows = items.slice((safePage - 1) * pageSize, safePage * pageSize);
  const emptyText = isCallLog
    ? "还没有调用日志。用画图功能生成或编辑图片后，这里会显示任务状态、耗时和图片链接。"
    : "没有找到日志";

  const loadLogs = async () => {
    setIsLoading(true);
    try {
      const data = await fetchSystemLogs({ type: effectiveType, start_date: startDate, end_date: endDate });
      setItems(data.items);
      setPage(1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载日志失败");
    } finally {
      setIsLoading(false);
    }
  };

  const clearFilters = () => {
    setStartDate("");
    setEndDate("");
  };

  const openDetail = (item: SystemLog) => {
    setDetailLog(item);
    setDetailOpen(true);
  };

  useEffect(() => {
    void loadLogs();
  }, [effectiveType, startDate, endDate]);

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Logs</div>
          <h1 className="text-2xl font-semibold tracking-tight">日志管理</h1>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          {isAdmin ? (
            <Select value={type} onValueChange={(value) => setType(value as (typeof LogType)[keyof typeof LogType])}>
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white sm:w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={LogType.Call}>调用日志</SelectItem>
                <SelectItem value={LogType.Account}>账号管理日志</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <div className="col-span-2 sm:col-span-1">
            <DateRangeFilter startDate={startDate} endDate={endDate} onChange={(start, end) => { setStartDate(start); setEndDate(end); }} />
          </div>
          <Button variant="outline" onClick={clearFilters} className="h-10 w-full rounded-xl border-stone-200 bg-white px-4 text-stone-700 sm:w-auto">
            清除筛选条件
          </Button>
          <Button onClick={() => void loadLogs()} disabled={isLoading} className="h-10 w-full rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800 sm:w-auto">
            {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
            查询
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4 text-sm text-stone-600">
            <span>共 {items.length} 条</span>
            <Button variant="ghost" className="h-8 rounded-lg px-3 text-stone-500" onClick={() => void loadLogs()} disabled={isLoading}>
              <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
          <div className="space-y-3 p-3 sm:hidden">
            {currentRows.map((item, index) => (
              <div key={`${item.time}-${index}`} className="rounded-2xl border border-stone-100 bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="secondary" className="rounded-md">{typeLabels[item.type] || item.type}</Badge>
                  {isCallLog ? (
                    <Badge variant={item.detail?.status === "failed" ? "danger" : "success"} className="rounded-md">
                      {getStatus(item)}
                    </Badge>
                  ) : null}
                </div>
                <div className="space-y-2 text-sm text-stone-600">
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-stone-400">时间</span>
                    <span className="text-right font-medium text-stone-700">{item.time}</span>
                  </div>
                  {isCallLog ? (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="shrink-0 text-stone-400">令牌</span>
                        <span className="min-w-0 break-all text-right font-medium text-stone-700">{getDetailText(item, "key_name")}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="shrink-0 text-stone-400">耗时</span>
                        <span className="text-right font-medium text-stone-700">{formatDuration(item)}</span>
                      </div>
                    </>
                  ) : null}
                  <div className="rounded-xl bg-stone-50 px-3 py-2 text-sm leading-6 text-stone-600">
                    {item.summary || "-"}
                  </div>
                </div>
                <Button variant="outline" className="mt-3 h-10 w-full rounded-xl border-stone-200 bg-white text-stone-700" onClick={() => openDetail(item)}>
                  查看详情
                </Button>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto sm:block">
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  {isCallLog ? <TableHead>令牌名称</TableHead> : null}
                  {isCallLog ? <TableHead>调用耗时</TableHead> : null}
                  {isCallLog ? <TableHead>状态</TableHead> : null}
                  <TableHead>简述</TableHead>
                  <TableHead className="w-28">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {currentRows.map((item, index) => (
                  <TableRow key={`${item.time}-${index}`} className="text-stone-600">
                    <TableCell className="whitespace-nowrap">{item.time}</TableCell>
                    <TableCell><Badge variant="secondary" className="rounded-md">{typeLabels[item.type] || item.type}</Badge></TableCell>
                    {isCallLog ? <TableCell>{getDetailText(item, "key_name")}</TableCell> : null}
                    {isCallLog ? <TableCell>{formatDuration(item)}</TableCell> : null}
                    {isCallLog ? (
                      <TableCell>
                        <Badge variant={item.detail?.status === "failed" ? "danger" : "success"} className="rounded-md">
                          {getStatus(item)}
                        </Badge>
                      </TableCell>
                    ) : null}
                    <TableCell className="max-w-[420px] truncate text-stone-500">{item.summary || "-"}</TableCell>
                    <TableCell>
                      <Button variant="ghost" className="h-8 rounded-lg px-3 text-stone-600" onClick={() => openDetail(item)}>
                        查看详情
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-stone-100 px-4 py-3 text-sm text-stone-500 sm:justify-end">
            <span className="basis-full text-center sm:basis-auto">第 {safePage} / {pageCount} 页，共 {items.length} 条</span>
            <Button variant="outline" size="icon" className="size-9 rounded-lg border-stone-200 bg-white" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon" className="size-9 rounded-lg border-stone-200 bg-white" disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
          {!isLoading && items.length === 0 ? <div className="px-6 py-14 text-center text-sm text-stone-500">{emptyText}</div> : null}
        </CardContent>
      </Card>
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="w-[min(92vw,920px)] rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle>日志详情</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 rounded-xl border border-stone-200 bg-white p-4 text-sm text-stone-600 md:grid-cols-2">
            {Object.entries(detailLog?.detail || {})
              .filter(([key, value]) => key !== "urls" && typeof value !== "object")
              .map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-4">
                  <span className="text-stone-400">{key}</span>
                  <span className="text-right font-medium text-stone-700">{String(value)}</span>
                </div>
              ))}
          </div>
          {detailUrls.length ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              {detailUrls.map((url, index) => (
                <button
                  key={url}
                  type="button"
                  className="aspect-square overflow-hidden rounded-xl border border-stone-200 bg-stone-100"
                  onClick={() => {
                    setLightboxIndex(index);
                    setLightboxOpen(true);
                  }}
                >
                  <img src={url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
          <pre className="max-h-[72vh] overflow-auto rounded-xl border border-stone-200 bg-stone-50 p-4 text-xs leading-6 text-stone-700">
            {JSON.stringify(detailLog?.detail || {}, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
      <ImageLightbox
        images={detailImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />
    </section>
  );
}

export default function LogsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin", "user"]);
  if (isCheckingAuth || !session) {
    return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-stone-400" /></div>;
  }
  return <LogsContent isAdmin={session.role === "admin"} />;
}
