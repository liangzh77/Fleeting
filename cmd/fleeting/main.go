// Command fleeting serves the private notes application. It also provides the
// small backup and password-hash helpers used by deployment and cron.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/liangzh77/fleeting/internal/ai"
	"github.com/liangzh77/fleeting/internal/auth"
	"github.com/liangzh77/fleeting/internal/config"
	"github.com/liangzh77/fleeting/internal/scheduler"
	"github.com/liangzh77/fleeting/internal/server"
	"github.com/liangzh77/fleeting/internal/store"
)

func main() {
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "serve":
		serve()
	case "backup":
		backupCommand(os.Args[2:])
	case "password", "hash-password":
		passwordCommand()
	case "version", "--version", "-v":
		fmt.Println("fleeting-go")
	default:
		fmt.Fprintln(os.Stderr, "用法：fleeting [serve|backup|password|version]")
		os.Exit(2)
	}
}

func serve() {
	if err := loadConfigAndMigrate(); err != nil {
		log.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(cfg.Database, cfg.Timezone, true)
	if err != nil {
		log.Fatal(err)
	}
	webRoot := os.Getenv("STATIC_ROOT")
	if webRoot == "" {
		webRoot = "web"
	}
	service := ai.New(st, cfg)
	app, err := server.New(cfg, st, service, webRoot)
	if err != nil {
		st.Close()
		log.Fatal(err)
	}
	runScheduler := scheduler.New(st, service)
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	httpServer := &http.Server{
		Addr:              net.JoinHostPort(host, port),
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	runScheduler.Start()
	errorsChannel := make(chan error, 1)
	go func() {
		log.Printf("Fleeting 服务已启动（Go；日志不记录原文或凭据）")
		errorsChannel <- httpServer.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	select {
	case signal := <-signals:
		log.Printf("收到 %s，正在停止", signal)
	case err := <-errorsChannel:
		if !errors.Is(err, http.ErrServerClosed) {
			runScheduler.Stop()
			st.Close()
			log.Fatal(err)
		}
	}
	runScheduler.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
	_ = st.Close()
}

func loadConfigAndMigrate() error {
	changed, err := config.MigratePassword(config.Path())
	if err != nil {
		return err
	}
	if changed {
		log.Printf("已将配置中的明文密码转换为哈希并删除明文字段")
	}
	return nil
}

func passwordCommand() {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
	if err != nil {
		log.Fatal(err)
	}
	password := strings.TrimSuffix(string(input), "\n")
	password = strings.TrimSuffix(password, "\r")
	hash, err := auth.HashPassword(password)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(hash)
}

func backupCommand(args []string) {
	directory := ""
	keep := 14
	destination := ""
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "-dir", "--dir":
			index++
			if index < len(args) {
				directory = args[index]
			}
		case "-keep", "--keep":
			index++
			if index < len(args) {
				_, _ = fmt.Sscanf(args[index], "%d", &keep)
			}
		default:
			destination = args[index]
		}
	}
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	if destination == "" {
		if directory == "" {
			directory = filepath.Join(filepath.Dir(cfg.Database), "..", "backups")
		}
		stamp := time.Now().UTC().Format("2006-01-02T15-04-05")
		destination = filepath.Join(directory, "fleeting-"+stamp+".sqlite")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		log.Fatal(err)
	}
	if err := store.Backup(cfg.Database, destination); err != nil {
		log.Fatal(err)
	}
	pruned, err := pruneBackups(filepath.Dir(destination), keep)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("SQLite 一致性备份完成：%s（保留 %d 份，清理 %d 份）\n", destination, keep, pruned)
}

func pruneBackups(directory string, keep int) (int, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return 0, err
	}
	type candidate struct {
		path  string
		mtime time.Time
	}
	files := make([]candidate, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "fleeting-") || !strings.HasSuffix(entry.Name(), ".sqlite") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return 0, err
		}
		files = append(files, candidate{path: filepath.Join(directory, entry.Name()), mtime: info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mtime.Before(files[j].mtime) })
	if keep < 0 {
		keep = 0
	}
	removeCount := len(files) - keep
	if removeCount < 0 {
		removeCount = 0
	}
	pruned := 0
	for index := 0; index < removeCount; index++ {
		if err := os.Remove(files[index].path); err != nil {
			return pruned, err
		}
		pruned++
	}
	return pruned, nil
}
