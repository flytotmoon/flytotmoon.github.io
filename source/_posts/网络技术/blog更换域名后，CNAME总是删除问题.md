---
title: blog更换域名后，CNAME总是删除问题
date: 2026-01-06 18:36:45
tags:
- 技术
- cmd
- web前端
- 个人博客
categories: 
- 网络技术
---

# blog更换域名后，CNAME总是删除问题

本人在给博客更换域名后发现一个算是很麻烦但又很简单的问题。在每次执行 `hexo d` 上传到 `git.` 时，CNAME 文件总是会被覆盖掉。导致自己的博客总是 404 ，只能重新再新建一个 CNAME 文件。

笔者深知这样下去不是长久之计，于是灵机一动之后动了一下。如果在 `source` 里面创建一个 CNAME 文件，不就能每次上传的时候一起上传了吗？

于是说干就干！不说废话了！有两个实现路径：

## 1.直接在source文件夹下创建

在你的博客文件夹 `blog/source` 下直接创建一个 `CNAME` 文件。（ 当然，里面要写上你的域名，应该不需要我提醒Q ） 

![示例图片](https://xsxtk.oss-cn-beijing.aliyuncs.com/img/54f74fa87d826aa9c522bba8d4948054.png)

## 2.通过 cmd 控制台创建文件

首先进入你的项目根目录的 `source` 目录下。

```cmd
cd source
```

接着创建并写入 CNAME 文件。( example 为示例，里面填上你的域名 )

```cmd
echo exmaple.com > CNAME
```

这样我们就成功在 `source` 文件夹下创建了一个 CNAME 文件！！！！

## 最后的最后

现在我们再次执行上传三部曲：

```cmd
hexo clean
hexo generate
hexo d
```

是不是可以神奇的发现不用再去 GitHub 仓库下创建一个 CNAME 文件了呢？

以上就是解决该问题的全部步骤了！！！！！

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Fira+Code&pause=1000&center=true&vCenter=true&width=435&lines=你学会了吗？（点击返回主页）)](https://blog.flytotmoon.cn)

